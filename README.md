# HomeyKomobi

Homey app for the [Komobi Moto](https://github.com/StefanIndustries/node-komobi) GPS tracker for motorcycles and scooters, built on [node-komobi](https://github.com/StefanIndustries/node-komobi).

## Features

- Every vehicle in your Komobi garage can be added as its own device. Devices use the Komobi shield as icon; the widget shows an icon per vehicle type (naked, chopper, racing, scooter, trail, cross, touring).
- Multiple Komobi accounts: pairing always asks for a login, and each device stores the account it came from. Vehicles of the same account share one client and one status call per poll; repairing a device updates the credentials of the other vehicles of that account too.
- Capabilities: status, riding, theft alarm (active/armed), tracker battery, vehicle battery voltage, odometer, speed, location, distance from home, last seen.
- Flow triggers: started riding, parked, ride recorded (distance, duration, speeds, driving score), theft alarm went off / armed / disarmed, location changed, arrived home / left home (radius), vehicle battery dropped below a voltage.
- Flow conditions: is riding, theft alarm is armed, theft alarm is going off, is within a radius of home.
- Flow action: refresh status.
- Dashboard widget with the status of one vehicle.
- App settings: update interval.