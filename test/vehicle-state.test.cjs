const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
    vehicleSnapshot, statusKey, detectChanges, distanceMeters, droppedBelow, crossedRadius, newRoutes, latestRouteId,
    rideTokens, vehicleType, vehicleName, accountKey, groupBy
} = require('../.homeybuild/drivers/vehicle/vehicle-state');

test('vehicles are grouped per Komobi account, ignoring e-mail capitals', () => {
    assert.equal(accountKey(' Rider@Example.com '), 'rider@example.com');
    const devices = [{ id: 1, email: 'a@x.nl' }, { id: 2, email: 'B@x.nl' }, { id: 3, email: 'A@X.nl' }];
    const groups = groupBy(devices, d => accountKey(d.email));
    assert.deepEqual([...groups.keys()], ['a@x.nl', 'b@x.nl']);
    assert.deepEqual(groups.get('a@x.nl').map(d => d.id), [1, 3]);
});

/** A vehicle as node-komobi maps it, with the raw alarm part shaped like the live API. */
const vehicle = ({ mode = 'PARKED', parked = true, armed = true, fired = false, alarmId = 10, lat = 51.948567, lon = 5.910607, volts = 13.1, type = 'CH', name = null } = {}) => ({
    vehicleId: '3a1990b0', brand: 'KAWASAKI', model: 'Z 650 RS', registrationNumber: '00-XXX-0', currentKm: 821, batteryVolts: 13.7,
    device: {
        operationMode: mode, parked, active: true, internalBatteryPercent: 80, externalBatteryVolts: volts,
        lastLocation: { latitude: lat, longitude: lon, speedKmh: 0 }, lastCommunication: new Date(1794313986000),
    },
    raw: { type, name, device: { alarms: { config: { enabled: armed }, status: { isFired: fired, lastAlarm: { id: alarmId } } } } },
});

test('snapshot reads the tracker status and the raw theft alarm', () => {
    const snapshot = vehicleSnapshot(vehicle());
    assert.equal(snapshot.riding, false);
    assert.equal(snapshot.theftAlarmArmed, true);
    assert.equal(snapshot.theftAlarmFired, false);
    assert.equal(snapshot.lastAlarmId, 10);
    assert.equal(snapshot.trackerBatteryPercent, 80);
    // The tracker's measurement wins over the vehicle record.
    assert.equal(snapshot.vehicleBatteryVolts, 13.1);
    assert.equal(snapshot.odometerKm, 821);
    assert.equal(statusKey(snapshot), 'parked');
});

test('riding and alarm status', () => {
    assert.equal(statusKey(vehicleSnapshot(vehicle({ mode: 'DRIVING', parked: false }))), 'riding');
    assert.equal(statusKey(vehicleSnapshot(vehicle({ fired: true }))), 'alarm');
    assert.equal(statusKey(vehicleSnapshot({ vehicleId: 'x', raw: {} })), 'unknown');
});

test('nothing changes on the first snapshot', () => {
    const changes = detectChanges(undefined, vehicleSnapshot(vehicle({ fired: true })));
    assert.deepEqual(changes, { startedRiding: false, parked: false, theftAlarmFired: false, theftAlarmArmed: false, theftAlarmDisarmed: false });
});

test('detects riding, parking, alarms, moves and voltage', () => {
    const parked = vehicleSnapshot(vehicle());
    const riding = vehicleSnapshot(vehicle({ mode: 'DRIVING', parked: false, lat: 51.96, volts: 13.9 }));
    const started = detectChanges(parked, riding);
    assert.equal(started.startedRiding, true);
    assert.equal(started.parked, false);
    assert.ok(started.movedMeters > 1000);
    assert.deepEqual(started.voltage, { previous: 13.1, current: 13.9 });
    assert.equal(detectChanges(riding, parked).parked, true);

    assert.equal(detectChanges(parked, vehicleSnapshot(vehicle({ fired: true }))).theftAlarmFired, true);
    // An alarm that came and went between two polls still counts.
    assert.equal(detectChanges(parked, vehicleSnapshot(vehicle({ alarmId: 11 }))).theftAlarmFired, true);
    assert.equal(detectChanges(parked, vehicleSnapshot(vehicle({ armed: false }))).theftAlarmDisarmed, true);
    assert.equal(detectChanges(vehicleSnapshot(vehicle({ armed: false })), parked).theftAlarmArmed, true);
});

test('GPS drift is not a location change', () => {
    const a = vehicleSnapshot(vehicle());
    const b = vehicleSnapshot(vehicle({ lat: 51.948567 + 0.0002 }));
    assert.equal(detectChanges(a, b).movedMeters, undefined);
});

test('distance, thresholds and home radius', () => {
    const d = distanceMeters(52.3676, 4.9041, 52.0907, 5.1214);
    assert.ok(Math.abs(d - 34400) < 1000, `Amsterdam-Utrecht was ${d}`);
    assert.ok(droppedBelow(12.4, 11.9, 12));
    assert.ok(!droppedBelow(11.9, 11.8, 12));
    assert.ok(crossedRadius(500, 100, 200, 'arrived'));
    assert.ok(!crossedRadius(150, 100, 200, 'arrived'));
    assert.ok(crossedRadius(100, 500, 200, 'left'));
    assert.ok(!crossedRadius(undefined, 500, 200, 'left'));
});

test('new rides come oldest first and only after the first check', () => {
    const routes = [41, 39, 40].map(routeId => ({ routeId, startedAt: new Date(), raw: {} }));
    assert.deepEqual(newRoutes(routes, undefined), []);
    assert.deepEqual(newRoutes(routes, 39).map(r => r.routeId), [40, 41]);
    assert.equal(latestRouteId(routes), 41);
    assert.equal(latestRouteId([]), undefined);
    assert.deepEqual(rideTokens({ routeId: 1, distanceKm: 42.46, durationSeconds: 3300, averageSpeedKmh: 46.2, maxSpeedKmh: 112.7, drivingScore: 8.44, raw: {} }),
        { distance: 42.5, duration: 55, average_speed: 46, max_speed: 113, driving_score: 8.4, name: '' });
});

test('vehicle type icons and names', () => {
    assert.equal(vehicleType(vehicle()), 'chopper');
    assert.equal(vehicleType(vehicle({ type: 'SC' })), 'scooter');
    assert.equal(vehicleType(vehicle({ type: 'XX' })), 'naked');
    assert.equal(vehicleName(vehicle()), 'Kawasaki Z 650 RS');
    assert.equal(vehicleName(vehicle({ name: ' My bike ' })), 'My bike');
});
