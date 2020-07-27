// TH10/TH16 WiFi Switch Plugin
// Copyright (c) James Pearce, 2020
// Last updated July 2020
//
// Version 1:
// - Creates a power outlet device, with embedded contact sensor (for temperature alerts, high or low, and
//   embedded temperature sensor.
// - Note: Supports a single attached DS18B20 sesnor currently. These devices follow a one-wire protocol so it may
//   be possible to connect two sensors, e.g. in a Fridge Freezer type appliance, to monitor both cavities in future.
//
// globals and imports
var request = require('request');

// HomeKit API registration
module.exports = (api) => {
  api.registerAccessory('TH10Switch', TH10Switch);
}


class TH10Switch {

  constructor(log, config, api) {
      this.log = log;
      this.config = config;
      this.api = api;

      this.Service = this.api.hap.Service;
      this.Characteristic = this.api.hap.Characteristic;

      this.name = config.name || 'My Appliance';
      this.th10IpAddress = config.th10IpAddress;
      this.th10StatusLocation = config.th10StatusLocation || '/cm?cmnd=status%208';
      this.th10OutletStatusLocation = config.th10OutletStatusLocation || '/cm?cmnd=power';
      this.th10OnLocation = config.th10OnLocation || '/cm?cmnd=power%20on';
      this.th10OffLocation = config.th10OffLocation || '/cm?cmnd=power%20on';
      this.pollTimer = config.pollTimer || 60; //default poll interval = 60 seconds
      this.alertCount = config.alertCount || 0; // number of consecutive alerts recorded before raising HomeKit alert status
      this.alertLowTemperature = config.alertLowTemperature || -5;
      this.alertHighTemperature = config.alertHighTemperature || 80;
      this.hysteresis = config.hysteresis || 3;

      this.state = {
        contactSensorState: 0,
        temperature: 0,
        outlet1On: 0,
        outlet1InUse: 0,
        outlet1Locked: 0,
        alerts: 0,
      };

      // Create the services
      this.outlet1Service = new this.Service.Outlet(this.outletName,"Outlet1"); // controls the relay
      this.contactSensor = new this.Service.ContactSensor(this.name); // reports open/close according to registered alert state
      this.temperatureService = new this.Service.TemperatureSensor(); // reports the measured temperature within the appliance

      // create an information service...
      this.informationService = new this.Service.AccessoryInformation()
        .setCharacteristic(this.Characteristic.Manufacturer, "James Pearce")
        .setCharacteristic(this.Characteristic.Model, "Sonoff TH10/TH16 WiFi Switch")
        .setCharacteristic(this.Characteristic.SerialNumber, "N/App");

      this.outlet1Service
        .getCharacteristic(this.Characteristic.On)
        .on('get', this.getOutlet1State.bind(this))
        .on('set', this.setOutlet1State.bind(this));
      this.outlet1Service
        .getCharacteristic(this.Characteristic.OutletInUse)
        .on('get', this.getOutlet1InUse.bind(this));

      this.contactSensor
        .setCharacteristic(this.Characteristic.Name, this.name)
        .getCharacteristic(this.Characteristic.ContactSensorState)
        .on('get', this.getContactState.bind(this));

      this.temperatureService
        .setCharacteristic(this.Characteristic.Name, "Current Temperature")
        .getCharacteristic(this.Characteristic.CurrentTemperature)
        .on('get', this.getTemperature.bind(this));

  } // constructor

  // mandatory getServices function tells HomeBridge how to use this object
  getServices() {
    var accessory = this;
    var Characteristic = this.Characteristic;
    var command;
    accessory.log.debug(accessory.name + ': Invoked getServices');

    // Initialise the plugin ahead of any function call with static configured IP address
    // we need to update HomeKit that this device can report temperatures below zero degrees:
    this.temperatureService.getCharacteristic(Characteristic.CurrentTemperature).props.minValue = -50;
    // ... and collect the data from the device...
    accessory.pollTH10State();

    // and retrun the services to HomeBridge
    return [
      accessory.informationService,
      accessory.outlet1Service,
      accessory.contactSensor,
      accessory.temperatureService,
    ];
  } // getServices()/

  getOutlet1State(callback) {
    var accessory = this;
    accessory.log.debug('Outlet (', accessory.outlet1Name, ') State: ', accessory.state.outlet1On);
    callback(null, accessory.state.outlet1On);
  }

  setOutlet1State(on, callback) {
    var accessory = this;
    var Characteristic = this.Characteristic;
    accessory.log.debug('setOutlet1State: ', on);
    accessory.pollState(); // (re)start polling timer

    if (on) {
      accessory.log('Outlet 1 Power on requested');
    } else {
      accessory.log('Outlet 1 Power off requested');
    }
    if (accessory.outlet1Locked) {
      accessory.log('Error: Outlet 1 is locked. Command not sent to device.');
      if (callback) callback(new Error('Error: Outlet 1 is locked (' + accessory.name + ')'), accessory.state.outlet1On);
    } else {
      var URI = "http://" + accessory.th10IpAddress;
      if (on) {
        URI = URI + accessory.th10OnLocation;
      } else {
        URI = URI + accessory.th10OffLocation;
      }

      accessory.log.debug("Calling: " + URI);

      try {
        request(URI, function(error, response, body) {
          accessory.log.debug(body);
          if (!error) {
            try {
              var sonoff_reply = JSON.parse(body);
              try {
                accessory.log.debug(sonoff_reply);
                var outletState = sonoff_reply.Power;
                if ((outletState == "ON") && (on)) {
                  accessory.state.outlet1On = 1;
                  accessory.state.outlet1InUse = 1;
                } else if ((outletState = "OFF") && (!on)) {
                  accessory.state.outlet1On = 0;
                  accessory.state.outlet1InUse = 0;
                }
              // update the object characteristics with the change
              accessory.log.debug('setOutlet1State command completed without error.');
              accessory.outlet1Service.updateCharacteristic(Characteristic.OutletInUse, accessory.state.outlet1InUse);
              } catch(err) {
                accessory.log('Device did not return expected status ("POWER":"ON" or "POWER":"OFF")');
                accessory.log(err);
              }
            } catch(err) {
              accessory.log('Device did not return valid JSON (' + sonoff_reply + ')');
              accessory.log(err);
            }
          } // if (!error)
        } ); // request
      } catch(err) {
        accessory.log('Error communicating with device');
        accessory.log(err);
      }

      if (callback) {
        callback(null, accessory.state.outlet1On);
      }
    } // if accessory.outlet1Locked
  } // setOutlet1State

  getOutlet1InUse(callback) {
    var accessory = this;
    accessory.log.debug('Outlet 1 (', accessory.outlet1Name, ') In Use: ' + accessory.state.outlet1InUse);
    callback(null, accessory.state.outlet1InUse);
  }

  getTemperature(callback) {
    var accessory = this;
    accessory.log.debug('Current temperature: ', accessory.state.temperature);
    callback(null, (accessory.state.temperature));
  }

  getContactState(callback) {
    var accessory = this;
    accessory.log.debug('Contact State (=Temperature Alert flag): ', accessory.state.contactSensorState);
    callback(null, accessory.state.contactSensorState);
  }

  pollTH10State(callback) {
    // Background status polling function.
    var accessory = this;
    var Characteristic = this.Characteristic;

    var URI = "http://" + accessory.th10IpAddress + accessory.th10StatusLocation;
    accessory.log.debug("pollState: Retrieving current device state from " + URI);

    try {
      request(URI, function(error, response, body) {
        accessory.log.debug(body);
        if (!error) {
          try {
            var sonoff_reply = JSON.parse(body);
            try {
              accessory.log.debug(sonoff_reply);
              var temperature = parseFloat(sonoff_reply.StatusSNS.DS18B20.Temperature);
              accessory.state.temperature = temperature;

              // process high temperature alarm states
              if ((accessory.state.contactSensorState == 0) & (temperature >= accessory.alertHighTemperature)) {
                accessory.log("WARNING: Alert threshold " + accessory.alertHighTemperature + "*C exceeded.");
                accessory.state.alerts += 1;
                if (accessory.state.alerts == accessory.alertCount) {
                  // consecutive alert count reached: raise alarm in HomeKit
                  accessory.log("WARNING: Alert count exceeded; raising alarm in HomeKit");
                  accessory.state.contactSensorState = 1;
                }
              } else if ((accessory.state.contactSensorState == 1) & (temperature <= (accessory.alertHighTemperature - accessory.hysteresis))) {
                accessory.log("INFORMATION: Previous alert condition cleared, reported temperature is " + temperature + "*C.");
                accessory.state.contactSensorState = 0;
                accessory.state.alerts = 0;
              } else if (accessory.state.alerts > 0) {
                // something else happened by we didn't log an alert state so clear the counter
                accessory.log.debug("INFORMATION: Temperature reported withn normal range, clearning alert count");
                accessory.state.alerts = 0;
              }

              // process low temperature alarm states
              if ((accessory.state.contactSensorState == 0) & (temperature <= accessory.alertLowTemperature)) {
                accessory.log("WARNING: Alert threshold " + accessory.alertLowTemperature + "*C passed.");
                accessory.state.alerts += 1;
                if (accessory.state.alerts == accessory.alertCount) {
                  // consecutive alert count reached: raise alarm in HomeKit
                  accessory.log("WARNING: Alert count exceeded; raising alarm in HomeKit");
                  accessory.state.contactSensorState = 1;
                }
              } else if ((accessory.state.contactSensorState == 1) & (temperature >= (accessory.alertLowTemperature + accessory.hysteresis))) {
                accessory.log("INFORMATION: Previous alert condition cleared, reported temperature is " + temperature + "*C.");
                accessory.state.contactSensorState = 0;
                accessory.state.alerts = 0;
              } else if (accessory.state.alerts > 0) {
                // something else happened by we didn't log an alert state so clear the counter
                accessory.log.debug("INFORMATION: Temperature reported withn normal range, clearning alert count");
                accessory.state.alerts = 0;
              }

              accessory.log.debug("pollTH10State: Updating accessory state...");
              accessory.contactSensor.updateCharacteristic(Characteristic.ContactSensorState, accessory.state.contactSensorState);
              accessory.temperatureService.updateCharacteristic(Characteristic.CurrentTemperature, accessory.state.temperature);
            } catch(err) {
              accessory.log('Could not convert data to number (' + sonoff_reply.StatusSNS.DS18B20.Temperature + ')');
              accessory.log(err);
            }
          } catch(err) {
            accessory.log('Invalid json received from device collecting temperature data:' + body);
            accessory.log(err);
          }
        }
      });
    } catch (err) {
      accessory.log(accessory.name+": Did not receive a valid response from device collecting temperature data: " + err.message);
      accessory.log(err);
    }

    URI = "http://" + accessory.th10IpAddress + accessory.th10OutletStatusLocation;
    accessory.log.debug("pollState: Retrieving current device outlet state from " + URI);

    try {
      request(URI, function(error, response, body) {
        accessory.log.debug(body);
        if (!error) {
          try {
            var sonoff_reply = JSON.parse(body);
            try {
              accessory.log.debug(sonoff_reply);
              var outletState = sonoff_reply.Power;
              if (outletState == "ON") {
                accessory.state.outlet1On = 1;
                accessory.state.outlet1InUse = 1;
              } else if (outletState = "OFF") {
                accessory.state.outlet1On = 0;
                accessory.state.outlet1InUse = 0;
              }
              // update the object characteristics with the change
              accessory.log.debug("pollUpsState: Updating outlet states...");
              accessory.outlet1Service.updateCharacteristic(Characteristic.On, accessory.state.outlet1On);
              accessory.outlet1Service.updateCharacteristic(Characteristic.OutletInUse, accessory.state.outlet1InUse);
            } catch(err) {
              accessory.log('Device did not return expected status ("POWER":"ON" or "POWER":"OFF")');
              accessory.log(err);
            }
          } catch(err) {
            accessory.log('Invalid json received from device collecting temperature data:' + body);
            accessory.log(err);
          }
        } // if
      });
    } catch(err) {
      accessory.log('Error communicating with device');
      accessory.log(err);
    }

    if (callback) {
      callback(null, accessory.state.outlet1On);
    }

    accessory.pollState(); // (re)start polling timer
  } // pollTH10State

  /**
    * Polling function
  */
  pollState = function() {
    var accessory = this;
    var Characteristic = this.Characteristic;

    // Clear any existing timer
    if (accessory.stateTimer) {
      clearTimeout(accessory.stateTimer);
      accessory.stateTimer = null;
    }

    // define the new poll function
    accessory.stateTimer = setTimeout(
      function() {
        accessory.pollTH10State(function(err, CurrentDeviceState) {
          if (err) {
            accessory.log(err);
            return;
          }
        })
      }, accessory.pollTimer * 1000
    );
  } // pollState

} // class FreezerAlarm
