import Homey from 'homey';
import { Komobi, KomobiVehicle } from 'node-komobi';
import type { KomobiVehicleDriver } from './driver';
import {
    detectChanges, latestRouteId, newRoutes, rideTokens, statusKey, distanceMeters,
    VehicleChanges, VehicleSnapshot, vehicleSnapshot, VehicleStatusKey
} from './vehicle-state';

/** Status of one vehicle as shown by the vehicle status widget. */
export interface VehicleWidgetStatus {
    name: string;
    description: string;
    status: VehicleStatusKey;
    statusText: string;
    theftAlarmArmed?: boolean;
    trackerBatteryPercent?: number;
    vehicleBatteryVolts?: number;
    keyFobBatteryPercent?: number;
    odometerKm?: number;
    speedKmh?: number;
    distanceFromHomeKm?: number;
    latitude?: number;
    longitude?: number;
    lastCommunication?: string;
    available: boolean;
}

export class KomobiVehicleDevice extends Homey.Device {
    private snapshot: VehicleSnapshot | undefined;
    private vehicle: KomobiVehicle | undefined;
    /** Meters from the Homey's location as of the last update. */
    private homeDistance: number | undefined;

    async onInit() {
        // Devices paired with an older version get the capabilities that were added since.
        for (const capability of <string[]> this.driver.manifest.capabilities) {
            if (!this.hasCapability(capability)) {
                await this.addCapability(capability).catch(this.error);
            }
        }
        this.log(`vehicle ${this.getName()} has been initialized`);
    }

    async onAdded() {
        // Fill in the values right away instead of waiting for the next poll.
        this.komobiDriver.updateDevices().catch(this.error);
    }

    private get komobiDriver(): KomobiVehicleDriver {
        return <KomobiVehicleDriver> this.driver;
    }

    public get vehicleId(): string {
        return this.getData().id;
    }

    /** Applies fresh data from Komobi and fires the flow triggers for what changed since the previous update. */
    public async updateVehicle(vehicle: KomobiVehicle): Promise<VehicleChanges> {
        const previous = this.snapshot;
        const previousHomeDistance = this.homeDistance;
        const next = vehicleSnapshot(vehicle);
        this.snapshot = next;
        this.vehicle = vehicle;
        this.homeDistance = this.distanceFromHome(next);

        await this.setCapabilities(next);
        if (!this.getAvailable()) {
            await this.setAvailable().catch(this.error);
        }
        await this.unsetWarning().catch(this.error);

        const changes = detectChanges(previous, next);
        this.fireTriggers(changes, next, previousHomeDistance);
        return changes;
    }

    private async setCapabilities(snapshot: VehicleSnapshot) {
        const key = statusKey(snapshot);
        await this.setValue('vehicle_status', key === 'unknown' && snapshot.operationMode
            ? snapshot.operationMode.charAt(0) + snapshot.operationMode.slice(1).toLowerCase()
            : this.homey.__(`status.${key}`));
        await this.setValue('riding', snapshot.riding);
        await this.setValue('alarm_theft', snapshot.theftAlarmFired);
        await this.setValue('theft_alarm_armed', snapshot.theftAlarmArmed);
        await this.setValue('measure_battery', snapshot.trackerBatteryPercent);
        await this.setValue('measure_voltage', snapshot.vehicleBatteryVolts);
        await this.setValue('meter_odometer', snapshot.odometerKm);
        await this.setValue('measure_speed', snapshot.speedKmh);
        await this.setValue('location_latitude', snapshot.latitude);
        await this.setValue('location_longitude', snapshot.longitude);
        await this.setValue('distance_from_home', this.homeDistance === undefined ? undefined : Number((this.homeDistance / 1000).toFixed(1)));
        await this.setValue('last_communication', this.formatDate(snapshot.lastCommunication));

        // Not every tracker has a key fob, so the capability only appears on vehicles that report one.
        if (snapshot.keyFobs.length > 0 && !this.hasCapability('measure_keyfob_battery')) {
            await this.addCapability('measure_keyfob_battery').catch(this.error);
        } else if (snapshot.keyFobs.length === 0 && this.hasCapability('measure_keyfob_battery')) {
            await this.removeCapability('measure_keyfob_battery').catch(this.error);
        }
        await this.setValue('measure_keyfob_battery', snapshot.keyFobBatteryPercent);
    }

    private async setValue(capability: string, value: string | number | boolean | undefined) {
        if (value === undefined || !this.hasCapability(capability) || this.getCapabilityValue(capability) === value) {
            return;
        }
        await this.setCapabilityValue(capability, value).catch(err => this.error(`failed to set ${capability}`, err));
    }

    private fireTriggers(changes: VehicleChanges, snapshot: VehicleSnapshot, previousHomeDistance: number | undefined) {
        const triggers = this.komobiDriver.triggers;
        const location = { latitude: snapshot.latitude ?? 0, longitude: snapshot.longitude ?? 0 };
        const odometer = snapshot.odometerKm ?? 0;
        const run = (card: Homey.FlowCardTriggerDevice, tokens: object = {}, state: object = {}) => {
            card.trigger(this, tokens, state).catch(this.error);
        };

        if (changes.startedRiding) {
            run(triggers.startedRiding, { ...location, odometer });
        }
        if (changes.parked) {
            run(triggers.parked, { ...location, odometer });
            // Komobi needs a moment to store the ride after the vehicle parks.
            this.komobiDriver.scheduleRideCheck(this);
        }
        if (changes.theftAlarmFired) {
            run(triggers.theftAlarmFired, location);
        }
        if (changes.theftAlarmArmed) {
            run(triggers.theftAlarmArmed);
        }
        if (changes.theftAlarmDisarmed) {
            run(triggers.theftAlarmDisarmed);
        }
        if (changes.movedMeters !== undefined) {
            run(triggers.locationChanged, {
                ...location,
                speed: snapshot.speedKmh ?? 0,
                distance_from_home: this.homeDistance === undefined ? 0 : Number((this.homeDistance / 1000).toFixed(1)),
            });
        }
        if (changes.voltage) {
            run(triggers.vehicleBatteryDroppedBelow, { voltage: changes.voltage.current }, changes.voltage);
        }
        if (previousHomeDistance !== undefined && this.homeDistance !== undefined && previousHomeDistance !== this.homeDistance) {
            const state = { previous: previousHomeDistance, current: this.homeDistance };
            run(triggers.arrivedHome, location, state);
            run(triggers.leftHome, location, state);
        }
        for (const fob of changes.keyFobBattery) {
            run(triggers.keyFobBatteryDroppedBelow, { key_fob: fob.id, battery: fob.current }, fob);
        }
        for (const id of changes.keyFobsForgotten) {
            run(triggers.keyFobForgotten, { key_fob: id, ...location });
        }
    }

    /** Fires "A ride was recorded" for rides Komobi stored since the last check. */
    public async checkRides(komobi: Komobi) {
        const routes = await komobi.getRoutes(this.vehicleId, { from: new Date(Date.now() - 3 * 24 * 3600 * 1000) });
        const lastRouteId: number | null = this.getStoreValue('lastRouteId');
        const latest = latestRouteId(routes);
        if (lastRouteId === null || lastRouteId === undefined) {
            // First check after pairing: remember where the history is, older rides are not news.
            await this.setStoreValue('lastRouteId', latest ?? 0);
            return;
        }
        for (const route of newRoutes(routes, lastRouteId)) {
            this.log(`new ride ${route.routeId} for ${this.getName()}`);
            await this.komobiDriver.triggers.rideFinished.trigger(this, rideTokens(route)).catch(this.error);
        }
        if (latest !== undefined && latest > lastRouteId) {
            await this.setStoreValue('lastRouteId', latest);
        }
    }

    private distanceFromHome(snapshot: VehicleSnapshot): number | undefined {
        const homeLatitude = this.homey.geolocation.getLatitude();
        const homeLongitude = this.homey.geolocation.getLongitude();
        if (typeof homeLatitude !== 'number' || typeof homeLongitude !== 'number' || (homeLatitude === 0 && homeLongitude === 0)
            || snapshot.latitude === undefined || snapshot.longitude === undefined) {
            return undefined;
        }
        return distanceMeters(homeLatitude, homeLongitude, snapshot.latitude, snapshot.longitude);
    }

    private formatDate(date: Date | undefined): string | undefined {
        if (!date) {
            return undefined;
        }
        try {
            return date.toLocaleString(this.homey.i18n.getLanguage(), {
                timeZone: this.homey.clock.getTimezone(), day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
            });
        } catch {
            return date.toISOString();
        }
    }

    // flow helpers

    public isRiding = () => this.snapshot?.riding === true;
    public isTheftAlarmArmed = () => this.snapshot?.theftAlarmArmed === true;
    public isTheftAlarmActive = () => this.snapshot?.theftAlarmFired === true;
    public isKeyFobForgotten = () => this.snapshot?.keyFobs.some(fob => fob.forgotten) === true;

    public isNearHome(radius: number): boolean {
        if (this.homeDistance === undefined) {
            throw new Error(this.homey.__('errors.no_location'));
        }
        return this.homeDistance <= radius;
    }

    public getWidgetStatus(): VehicleWidgetStatus {
        const snapshot: VehicleSnapshot = this.snapshot ?? { keyFobs: [] };
        const key = statusKey(snapshot);
        const vehicle = this.vehicle;
        return {
            name: this.getName(),
            description: [vehicle?.model, vehicle?.registrationNumber].filter(Boolean).join(' · '),
            status: key,
            statusText: this.getCapabilityValue('vehicle_status') ?? this.homey.__(`status.${key}`),
            theftAlarmArmed: snapshot.theftAlarmArmed,
            trackerBatteryPercent: snapshot.trackerBatteryPercent,
            vehicleBatteryVolts: snapshot.vehicleBatteryVolts,
            keyFobBatteryPercent: snapshot.keyFobBatteryPercent,
            odometerKm: snapshot.odometerKm,
            speedKmh: snapshot.speedKmh,
            distanceFromHomeKm: this.homeDistance === undefined ? undefined : Number((this.homeDistance / 1000).toFixed(1)),
            latitude: snapshot.latitude,
            longitude: snapshot.longitude,
            lastCommunication: snapshot.lastCommunication?.toISOString(),
            available: this.getAvailable(),
        };
    }
}

module.exports = KomobiVehicleDevice;
