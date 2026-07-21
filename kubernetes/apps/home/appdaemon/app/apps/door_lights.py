import appdaemon.plugins.hass.hassapi as hass
##############################################################################################
# Args:
#
# sensor: binary sensor to use as trigger. several motion detectors are seperated with ,
# entity_on : entity to turn on when detecting motion, can be a light, script, scene or anything else that can be turned on. more lights are sepetated with ,
# entity_off : entity to turn off when detecting motion, can be a light, script or anything else that can be turned off. Can also be a scene which will be turned on. more lights are sepetated with ,
# delay: amount of time after turning on to turn off again. If not specified defaults to 60 seconds.
#
# Release Notes
#
# Version 1.2:
#   Added more robust turn off mechanism to handle motion detectors that stay on for the duration of motion
#   Added check to see if light was already on when we received motion and not turn it off after motion ends
# Version 1.1:
#   Added option for several lights, scripts, scenes (Rene Tode)
#   Added option for several motiondetectors (Rene Tode)
#   Added option to just turn out light after timer ended (Rene Tode)
#   Added controle if timer from motionsensor is longer then the delay (Rene Tode)
#   Changed handlenaming bug (Rene Tode)
#   Changed reset flow (Rene Tode)
# Version 1.0:
#   Initial Version (aimc)

class DoorLights(hass.Hass):

  def initialize(self):
    
    self.handle = None
    self.we_turned_on = False
    
    if "sensor" in self.args:
      self.sensors = self.args["sensor"].split(",")
      for sensor in self.sensors:
        self.listen_state(self.motion, sensor)
    else:
      self.log("No sensor specified, doing nothing")
    
  def motion(self, entity, attribute, old, new, kwargs):
    if new == "on" or new == "open":
      # should we be doing this?
      if not self.get_state("input_boolean.detect_motion"):
        self.log("not detecting motion")
        return

      if not self.handle == None:
        self.cancel_timer(self.handle)
        self.handle = None
      if "entity_on" in self.args:
        on_entities = self.args["entity_on"].split(",")
        for on_entity in on_entities:
          self.turn_on(on_entity)
        self.log("Door open: i turned {} on".format(self.args["entity_on"]))
        self.we_turned_on = True
    elif self.we_turned_on and (new == "off" or new == "closed"):
      if 'delay' in self.args:
        delay = self.args['delay']
        self.handle = self.run_in(self.light_off, delay)
      else:
        light_off(self, kwargs)

  def light_off(self, kwargs):
      if "entity_off" in self.args:
        off_entities = self.args["entity_off"].split(",")
        for off_entity in off_entities:
          # If it's a scene we need to turn it on not off
          device, entity = self.split_entity(off_entity)
          if device == "scene":
            self.log("Turning off scene because timeout after close {}".format(off_entity))
            self.turn_on(off_entity)
          else:
            self.log("Turning off due to timeout after close {}".format(off_entity))
            self.turn_off(off_entity)
        self.we_turned_on = False
