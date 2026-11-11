# HomeyKomobi

Homey app for the [Komobi Moto](https://github.com/StefanIndustries/node-komobi) GPS tracker for motorcycles and scooters, built on [node-komobi](https://github.com/StefanIndustries/node-komobi).

## Features

- Every vehicle in your Komobi garage can be added as its own device. Devices and the widget use the Komobi shield as icon.
- Multiple Komobi accounts: pairing always asks for a login, and each device stores the account it came from. Vehicles of the same account share one client and one status call per poll; repairing a device updates the credentials of the other vehicles of that account too.
- Capabilities: status, riding, theft alarm (active/armed), tracker battery, vehicle battery voltage, key fob battery (lowest of the enabled fobs; only on vehicles with a key fob), odometer, speed, location, distance from home, last seen.
- Flow triggers: started riding, parked, ride recorded (distance, duration, speeds, driving score), theft alarm went off / armed / disarmed, location changed, arrived home / left home (radius), vehicle battery dropped below a voltage, key fob battery dropped below a percentage, key fob was left behind.
- Flow conditions: is riding, theft alarm is armed, theft alarm is going off, a key fob is left behind, is within a radius of home.
- Flow action: refresh status.
- Dashboard widget with the status of one vehicle.
- App settings: update interval.