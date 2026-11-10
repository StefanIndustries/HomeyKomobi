import Homey from 'homey';
import { KomobiVehicleDriver } from './drivers/vehicle/driver';
import { KomobiVehicleDevice, VehicleWidgetStatus } from './drivers/vehicle/device';

export class KomobiApp extends Homey.App {

  async onInit() {
    this.log('KomobiApp has been initialized');
  }

  private getDriver(): KomobiVehicleDriver {
    return <KomobiVehicleDriver> this.homey.drivers.getDriver('vehicle');
  }

  /** Status of one vehicle for the vehicle status widget, or null when the device no longer exists. */
  async getVehicleStatus(deviceId: string | undefined): Promise<VehicleWidgetStatus | null> {
    const devices = <KomobiVehicleDevice[]> this.getDriver().getDevices();
    const device = deviceId ? devices.find(d => d.getId() === deviceId) : devices[0];
    return device ? device.getWidgetStatus() : null;
  }
}

module.exports = KomobiApp;
