import Homey from 'homey';
import PairSession from 'homey/lib/PairSession';
import { Komobi, KomobiLoginError, KomobiVehicle } from 'node-komobi';
import { KomobiVehicleDevice } from './device';
import { accountKey, crossedRadius, droppedBelow, groupBy, vehicleName, vehicleType } from './vehicle-state';

const DEFAULT_POLLING_INTERVAL = 60000;
const MIN_POLLING_INTERVAL = 30000;
/** An account that failed is skipped for this many poll intervals, so a wrong password does not hammer the login. */
const FAILED_ACCOUNT_BACKOFF = 5;
/** Ride history is checked this often, besides right after a vehicle parks. */
const RIDE_CHECK_INTERVAL = 10 * 60000;
/** Komobi needs a moment after parking before the ride shows up in the history. */
const RIDE_CHECK_DELAY_AFTER_PARKING = 3 * 60000;

export interface VehicleTriggers {
    startedRiding: Homey.FlowCardTriggerDevice;
    parked: Homey.FlowCardTriggerDevice;
    rideFinished: Homey.FlowCardTriggerDevice;
    theftAlarmFired: Homey.FlowCardTriggerDevice;
    theftAlarmArmed: Homey.FlowCardTriggerDevice;
    theftAlarmDisarmed: Homey.FlowCardTriggerDevice;
    locationChanged: Homey.FlowCardTriggerDevice;
    arrivedHome: Homey.FlowCardTriggerDevice;
    leftHome: Homey.FlowCardTriggerDevice;
    vehicleBatteryDroppedBelow: Homey.FlowCardTriggerDevice;
}

/** A logged-in Komobi account, shared by every vehicle that was paired with it. */
interface KomobiAccount {
    client: Komobi;
    password: string;
    /** Epoch ms before which the account is not polled again after a failure. */
    retryAfter: number;
}

export class KomobiVehicleDriver extends Homey.Driver {
    public triggers!: VehicleTriggers;

    /** Clients by account key (lowercase e-mail). Each Homey user can pair vehicles from their own Komobi account. */
    private accounts = new Map<string, KomobiAccount>();
    private pollTimeout: NodeJS.Timeout | undefined;
    private rideCheckTimeouts = new Map<string, NodeJS.Timeout>();
    private lastRideCheck = 0;
    private updating: Promise<void> | undefined;

    async onInit() {
        this.registerFlowCards();
        this.homey.settings.on('set', (key: string) => {
            if (key === 'pollingInterval') {
                this.schedulePoll();
            }
        });
        this.schedulePoll();
        // No flows fire on this first update: devices have nothing to compare with yet.
        this.updateDevices().catch(err => this.error('initial update failed', err));
        this.log('KomobiVehicleDriver has been initialized');
    }

    async onUninit() {
        this.homey.clearTimeout(this.pollTimeout);
        this.rideCheckTimeouts.forEach(timeout => this.homey.clearTimeout(timeout));
        this.rideCheckTimeouts.clear();
        this.accounts.forEach(account => account.client.dispose());
        this.accounts.clear();
    }

    private createClient(email: string, password: string): Komobi {
        return new Komobi({ email, password, timeZone: this.homey.clock.getTimezone() });
    }

    /** The client for the account a device was paired with, created on first use and replaced when the password changed. */
    private getAccount(device: KomobiVehicleDevice): KomobiAccount | undefined {
        const email = device.getStoreValue('email');
        const password = device.getStoreValue('password');
        if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
            return undefined;
        }
        const key = accountKey(email);
        const existing = this.accounts.get(key);
        if (existing && existing.password === password) {
            return existing;
        }
        existing?.client.dispose();
        const account = { client: this.createClient(email, password), password, retryAfter: 0 };
        this.accounts.set(key, account);
        return account;
    }

    public getClient(device: KomobiVehicleDevice): Komobi | undefined {
        return this.getAccount(device)?.client;
    }

    private get pollingInterval(): number {
        const interval = Number(this.homey.settings.get('pollingInterval'));
        return Number.isFinite(interval) && interval > 0 ? Math.max(interval, MIN_POLLING_INTERVAL) : DEFAULT_POLLING_INTERVAL;
    }

    private schedulePoll() {
        this.homey.clearTimeout(this.pollTimeout);
        this.pollTimeout = this.homey.setTimeout(async () => {
            await this.updateDevices().catch(err => this.error('update failed', err));
            this.schedulePoll();
        }, this.pollingInterval);
    }

    /** Refreshes every vehicle with one call per Komobi account. Concurrent callers share the running update. */
    public async updateDevices(force = false): Promise<void> {
        if (!this.updating) {
            this.updating = this.doUpdateDevices(force).finally(() => {
                this.updating = undefined;
            });
        }
        return this.updating;
    }

    private async doUpdateDevices(force: boolean) {
        const devices = <KomobiVehicleDevice[]> this.getDevices();
        const checkRides = Date.now() - this.lastRideCheck >= RIDE_CHECK_INTERVAL;
        if (checkRides) {
            this.lastRideCheck = Date.now();
        }

        const byAccount = groupBy(devices, device => {
            const email = device.getStoreValue('email');
            return typeof email === 'string' && email ? accountKey(email) : '';
        });
        for (const [key, accountDevices] of byAccount) {
            if (!key) {
                await Promise.all(accountDevices.map(device => device.setUnavailable(this.homey.__('errors.not_logged_in')).catch(this.error)));
                continue;
            }
            await this.updateAccount(accountDevices, force, checkRides);
        }

        // Forget clients of accounts whose last vehicle was removed.
        for (const [key, account] of this.accounts) {
            if (!byAccount.has(key)) {
                account.client.dispose();
                this.accounts.delete(key);
            }
        }
    }

    private async updateAccount(devices: KomobiVehicleDevice[], force: boolean, checkRides: boolean) {
        const account = this.getAccount(devices[0]);
        if (!account || (!force && Date.now() < account.retryAfter)) {
            return;
        }
        let vehicles: KomobiVehicle[];
        try {
            vehicles = await account.client.getVehicles(this.homey.i18n.getLanguage());
            account.retryAfter = 0;
        } catch (err) {
            this.error(`failed to fetch the vehicles of ${devices[0].getStoreValue('email')}`, err);
            account.retryAfter = Date.now() + this.pollingInterval * FAILED_ACCOUNT_BACKOFF;
            if (err instanceof KomobiLoginError) {
                await Promise.all(devices.map(device => device.setUnavailable(this.homey.__('errors.login_failed')).catch(this.error)));
            } else {
                await Promise.all(devices.map(device => device.setWarning(this.homey.__('errors.unreachable')).catch(this.error)));
            }
            return;
        }

        for (const device of devices) {
            const vehicle = vehicles.find(v => v.vehicleId === device.vehicleId);
            if (!vehicle) {
                await device.setUnavailable(this.homey.__('errors.vehicle_not_found')).catch(this.error);
                continue;
            }
            try {
                await device.updateVehicle(vehicle);
            } catch (err) {
                this.error(`failed to update ${device.getName()}`, err);
            }
            if (checkRides) {
                await this.checkRides(device);
            }
        }
    }

    private async checkRides(device: KomobiVehicleDevice) {
        const client = this.getClient(device);
        if (!client || !device.getAvailable()) {
            return;
        }
        try {
            await device.checkRides(client);
        } catch (err) {
            this.error(`failed to check rides of ${device.getName()}`, err);
        }
    }

    public scheduleRideCheck(device: KomobiVehicleDevice) {
        const id = device.vehicleId;
        this.homey.clearTimeout(this.rideCheckTimeouts.get(id));
        this.rideCheckTimeouts.set(id, this.homey.setTimeout(() => {
            this.rideCheckTimeouts.delete(id);
            this.checkRides(device).catch(this.error);
        }, RIDE_CHECK_DELAY_AFTER_PARKING));
    }

    private registerFlowCards() {
        const trigger = (id: string) => this.homey.flow.getDeviceTriggerCard(id);
        this.triggers = {
            startedRiding: trigger('started-riding'),
            parked: trigger('parked'),
            rideFinished: trigger('ride-finished'),
            theftAlarmFired: trigger('theft-alarm-fired'),
            theftAlarmArmed: trigger('theft-alarm-armed'),
            theftAlarmDisarmed: trigger('theft-alarm-disarmed'),
            locationChanged: trigger('location-changed'),
            arrivedHome: trigger('arrived-home'),
            leftHome: trigger('left-home'),
            vehicleBatteryDroppedBelow: trigger('vehicle-battery-dropped-below'),
        };

        type Distances = { previous: number, current: number };
        this.triggers.arrivedHome.registerRunListener(async (args: { radius: number }, state: Distances) => {
            return crossedRadius(state.previous, state.current, args.radius, 'arrived');
        });
        this.triggers.leftHome.registerRunListener(async (args: { radius: number }, state: Distances) => {
            return crossedRadius(state.previous, state.current, args.radius, 'left');
        });
        this.triggers.vehicleBatteryDroppedBelow.registerRunListener(async (args: { voltage: number }, state: Distances) => {
            return droppedBelow(state.previous, state.current, args.voltage);
        });

        type DeviceArgs = { device: KomobiVehicleDevice };
        this.homey.flow.getConditionCard('is-riding')
            .registerRunListener(async (args: DeviceArgs) => args.device.isRiding());
        this.homey.flow.getConditionCard('theft-alarm-is-armed')
            .registerRunListener(async (args: DeviceArgs) => args.device.isTheftAlarmArmed());
        this.homey.flow.getConditionCard('theft-alarm-is-active')
            .registerRunListener(async (args: DeviceArgs) => args.device.isTheftAlarmActive());
        this.homey.flow.getConditionCard('is-near-home')
            .registerRunListener(async (args: DeviceArgs & { radius: number }) => args.device.isNearHome(args.radius));

        this.homey.flow.getActionCard('refresh-vehicle')
            .registerRunListener(async (args: DeviceArgs) => {
                if (!this.getClient(args.device)) {
                    throw new Error(this.homey.__('errors.not_logged_in'));
                }
                await this.updateDevices(true);
            });
    }

    /** Checks the credentials and returns the account's vehicles. */
    private async tryLogin(email: string, password: string): Promise<{ client: Komobi, vehicles: KomobiVehicle[] }> {
        const client = this.createClient(email, password);
        try {
            await client.login();
            const vehicles = await client.getVehicles(this.homey.i18n.getLanguage());
            return { client, vehicles };
        } catch (err) {
            client.dispose();
            this.error('login failed', err);
            throw new Error(err instanceof KomobiLoginError ? this.homey.__('errors.invalid_credentials') : this.homey.__('errors.unreachable'));
        }
    }

    /** Keeps a client that just logged in, so the first poll of new or repaired devices does not log in again. */
    private keepClient(email: string, password: string, client: Komobi) {
        const key = accountKey(email);
        this.accounts.get(key)?.client.dispose();
        this.accounts.set(key, { client, password, retryAfter: 0 });
    }

    async onPair(session: PairSession) {
        // Every pair session logs in, so each Homey user adds the vehicles of their own Komobi account.
        let account: { email: string, password: string, vehicles: KomobiVehicle[] } | undefined;

        session.setHandler('login', async (data: { username: string, password: string }) => {
            const email = data.username.trim();
            const result = await this.tryLogin(email, data.password);
            this.keepClient(email, data.password, result.client);
            account = { email, password: data.password, vehicles: result.vehicles };
            return true;
        });

        session.setHandler('list_devices', async () => {
            if (!account) {
                return [];
            }
            const { email, password, vehicles } = account;
            return vehicles.map(vehicle => ({
                name: vehicleName(vehicle),
                data: {
                    id: vehicle.vehicleId,
                },
                store: {
                    email,
                    password,
                    deviceId: vehicle.deviceId,
                    type: vehicleType(vehicle),
                },
            }));
        });
    }

    async onRepair(session: PairSession, repairedDevice: Homey.Device) {
        const device = <KomobiVehicleDevice> repairedDevice;
        session.setHandler('login', async (data: { username: string, password: string }) => {
            const email = data.username.trim();
            const result = await this.tryLogin(email, data.password);
            if (!result.vehicles.some(vehicle => vehicle.vehicleId === device.vehicleId)) {
                result.client.dispose();
                throw new Error(this.homey.__('errors.vehicle_not_in_account'));
            }
            this.keepClient(email, data.password, result.client);

            // The other vehicles of the same account get the new credentials too, as long as the account still has them.
            const oldEmail = device.getStoreValue('email');
            const oldKey = typeof oldEmail === 'string' ? accountKey(oldEmail) : undefined;
            const devices = (<KomobiVehicleDevice[]> this.getDevices()).filter(other => other === device || (
                oldKey !== undefined && accountKey(String(other.getStoreValue('email') ?? '')) === oldKey
                && result.vehicles.some(vehicle => vehicle.vehicleId === other.vehicleId)
            ));
            for (const other of devices) {
                await other.setStoreValue('email', email);
                await other.setStoreValue('password', data.password);
            }
            this.updateDevices(true).catch(err => this.error('update after repair failed', err));
            return true;
        });
    }
}

module.exports = KomobiVehicleDriver;
