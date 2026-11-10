'use strict';

module.exports = {
  async getVehicleStatus({ homey, query }) {
    return homey.app.getVehicleStatus(query.deviceId);
  },
};
