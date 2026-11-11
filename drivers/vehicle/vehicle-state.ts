import { KomobiRoute, KomobiVehicle } from 'node-komobi';

/* Pure helpers that turn Komobi vehicle data into capability values and flow events. Kept free of Homey so they can be tested. */

export type VehicleStatusKey = 'alarm' | 'riding' | 'parked' | 'unknown';

/** Everything the device shows about a vehicle at one moment. */
export interface VehicleSnapshot {
    operationMode?: string;
    riding?: boolean;
    theftAlarmArmed?: boolean;
    theftAlarmFired?: boolean;
    /** Id of the last theft alarm; increases when a new alarm went off, even if it is over by the next poll. */
    lastAlarmId?: number;
    trackerBatteryPercent?: number;
    vehicleBatteryVolts?: number;
    odometerKm?: number;
    speedKmh?: number;
    latitude?: number;
    longitude?: number;
    lastCommunication?: Date;
    /** Bluetooth key fobs of the tracker. */
    keyFobs: KeyFob[];
    /** Lowest battery charge of the enabled key fobs, in percent. */
    keyFobBatteryPercent?: number;
}

export interface KeyFob {
    /** Bluetooth id, as the Komobi app shows it. */
    id: string;
    batteryPercent?: number;
    enabled: boolean;
    /** True while Komobi warns the key fob was left behind. */
    forgotten: boolean;
}

/** What changed between two snapshots, used to fire the flow triggers. */
export interface VehicleChanges {
    startedRiding: boolean;
    parked: boolean;
    theftAlarmFired: boolean;
    theftAlarmArmed: boolean;
    theftAlarmDisarmed: boolean;
    /** Meters moved since the previous snapshot, when the vehicle moved far enough to count. */
    movedMeters?: number;
    /** Previous and current vehicle battery voltage, when it changed. */
    voltage?: { previous: number, current: number };
    /** Key fobs whose battery charge changed. */
    keyFobBattery: { id: string, previous: number, current: number }[];
    /** Key fobs Komobi started warning about being left behind. */
    keyFobsForgotten: string[];
}

/** Moves smaller than this are GPS drift, not a location change. */
export const MIN_MOVE_METERS = 50;

type Raw = Record<string, unknown>;
const obj = (value: unknown): Raw => (value && typeof value === 'object' ? value as Raw : {});
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** Reads the theft alarm part of the raw vehicle, which node-komobi does not map yet. */
const theftAlarm = (vehicle: KomobiVehicle) => {
    const alarms = obj(obj(obj(vehicle.raw).device).alarms);
    const config = obj(alarms.config);
    const status = obj(alarms.status);
    return {
        armed: typeof config.enabled === 'boolean' ? config.enabled : undefined,
        fired: typeof status.isFired === 'boolean' ? status.isFired : undefined,
        lastAlarmId: num(obj(status.lastAlarm).id),
    };
};

export function keyFobs(vehicle: KomobiVehicle): KeyFob[] {
    return (vehicle.device?.keychains ?? []).map(keychain => ({
        id: keychain.bleId,
        batteryPercent: keychain.batteryPercent,
        enabled: keychain.enabled !== false,
        forgotten: keychain.forgottenWarning === true,
    }));
}

export function vehicleSnapshot(vehicle: KomobiVehicle): VehicleSnapshot {
    const device = vehicle.device;
    const alarm = theftAlarm(vehicle);
    const fobs = keyFobs(vehicle);
    const fobBatteries = fobs.filter(fob => fob.enabled && fob.batteryPercent !== undefined).map(fob => fob.batteryPercent!);
    const mode = device?.operationMode?.toUpperCase();
    const riding = device ? (mode ? mode !== 'PARKED' && !device.parked : !device.parked) : undefined;
    return {
        operationMode: mode,
        riding,
        theftAlarmArmed: alarm.armed,
        theftAlarmFired: alarm.fired,
        lastAlarmId: alarm.lastAlarmId,
        trackerBatteryPercent: device?.internalBatteryPercent,
        // The tracker's own measurement is the most recent; the vehicle record only updates with telemetry.
        vehicleBatteryVolts: device?.externalBatteryVolts ?? vehicle.batteryVolts,
        odometerKm: vehicle.currentKm,
        speedKmh: device?.lastLocation?.speedKmh,
        latitude: device?.lastLocation?.latitude,
        longitude: device?.lastLocation?.longitude,
        lastCommunication: device?.lastCommunication ?? vehicle.lastActivity,
        keyFobs: fobs,
        keyFobBatteryPercent: fobBatteries.length > 0 ? Math.min(...fobBatteries) : undefined,
    };
}

export function statusKey(snapshot: VehicleSnapshot): VehicleStatusKey {
    if (snapshot.theftAlarmFired) {
        return 'alarm';
    }
    if (snapshot.riding === undefined) {
        return 'unknown';
    }
    return snapshot.riding ? 'riding' : 'parked';
}

/** Great-circle distance in meters. */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const rad = (deg: number) => deg * Math.PI / 180;
    const dLat = rad(lat2 - lat1);
    const dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Changes from `previous` to `next`. Without a previous snapshot (first poll after start) nothing counts as changed. */
export function detectChanges(previous: VehicleSnapshot | undefined, next: VehicleSnapshot): VehicleChanges {
    const changes: VehicleChanges = {
        startedRiding: false, parked: false, theftAlarmFired: false, theftAlarmArmed: false, theftAlarmDisarmed: false,
        keyFobBattery: [], keyFobsForgotten: [],
    };
    if (!previous) {
        return changes;
    }
    if (previous.riding !== undefined && next.riding !== undefined && previous.riding !== next.riding) {
        changes.startedRiding = next.riding;
        changes.parked = !next.riding;
    }
    const newAlarmId = next.lastAlarmId !== undefined && previous.lastAlarmId !== undefined && next.lastAlarmId > previous.lastAlarmId;
    changes.theftAlarmFired = (next.theftAlarmFired === true && previous.theftAlarmFired === false) || newAlarmId;
    if (previous.theftAlarmArmed !== undefined && next.theftAlarmArmed !== undefined && previous.theftAlarmArmed !== next.theftAlarmArmed) {
        changes.theftAlarmArmed = next.theftAlarmArmed;
        changes.theftAlarmDisarmed = !next.theftAlarmArmed;
    }
    if (previous.latitude !== undefined && previous.longitude !== undefined && next.latitude !== undefined && next.longitude !== undefined) {
        const moved = distanceMeters(previous.latitude, previous.longitude, next.latitude, next.longitude);
        if (moved >= MIN_MOVE_METERS) {
            changes.movedMeters = moved;
        }
    }
    if (previous.vehicleBatteryVolts !== undefined && next.vehicleBatteryVolts !== undefined && previous.vehicleBatteryVolts !== next.vehicleBatteryVolts) {
        changes.voltage = { previous: previous.vehicleBatteryVolts, current: next.vehicleBatteryVolts };
    }
    for (const fob of next.keyFobs) {
        const before = previous.keyFobs.find(old => old.id === fob.id);
        if (!before) {
            continue;
        }
        if (before.batteryPercent !== undefined && fob.batteryPercent !== undefined && before.batteryPercent !== fob.batteryPercent) {
            changes.keyFobBattery.push({ id: fob.id, previous: before.batteryPercent, current: fob.batteryPercent });
        }
        if (fob.forgotten && !before.forgotten) {
            changes.keyFobsForgotten.push(fob.id);
        }
    }
    return changes;
}

/** True when a value went from at or above the threshold to below it. */
export const droppedBelow = (previous: number, current: number, threshold: number) => previous >= threshold && current < threshold;

/** True when the vehicle crossed into (`arrived`) or out of (`left`) the circle around home. */
export function crossedRadius(previousMeters: number | undefined, currentMeters: number | undefined, radius: number, direction: 'arrived' | 'left'): boolean {
    if (previousMeters === undefined || currentMeters === undefined) {
        return false;
    }
    return direction === 'arrived'
        ? previousMeters > radius && currentMeters <= radius
        : previousMeters <= radius && currentMeters > radius;
}

/** Rides newer than `lastRouteId`, oldest first, so flows run in the order the rides happened. */
export function newRoutes(routes: KomobiRoute[], lastRouteId: number | undefined): KomobiRoute[] {
    if (lastRouteId === undefined) {
        return [];
    }
    return routes
        .filter(route => route.routeId > lastRouteId)
        .sort((a, b) => a.routeId - b.routeId);
}

export const latestRouteId = (routes: KomobiRoute[]): number | undefined => routes.length > 0
    ? Math.max(...routes.map(route => route.routeId))
    : undefined;

const round = (value: number | undefined, decimals: number) => value === undefined ? 0 : Number(value.toFixed(decimals));

export function rideTokens(route: KomobiRoute) {
    return {
        distance: round(route.distanceKm, 1),
        duration: round(route.durationSeconds === undefined ? undefined : route.durationSeconds / 60, 0),
        average_speed: round(route.averageSpeedKmh, 0),
        max_speed: round(route.maxSpeedKmh, 0),
        driving_score: round(route.drivingScore, 1),
        name: route.name ?? '',
    };
}

/** Komobi accounts are e-mail addresses; the same address typed with other capitals is the same account. */
export const accountKey = (email: string) => email.trim().toLowerCase();

export function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
    const groups = new Map<K, T[]>();
    for (const item of items) {
        const k = key(item);
        groups.set(k, [...(groups.get(k) ?? []), item]);
    }
    return groups;
}

export function vehicleName(vehicle: KomobiVehicle): string {
    const raw = obj(vehicle.raw);
    if (typeof raw.name === 'string' && raw.name.trim()) {
        return raw.name.trim();
    }
    // Brands come in capitals ("KAWASAKI"); models keep their own spelling ("Z 650 RS").
    const brand = vehicle.brand?.toLowerCase().replace(/(^|[\s-])\w/g, c => c.toUpperCase());
    const title = [brand, vehicle.model].filter(Boolean).join(' ');
    return title || vehicle.registrationNumber || 'Komobi';
}
