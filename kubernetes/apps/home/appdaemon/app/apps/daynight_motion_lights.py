import appdaemon.plugins.hass.hassapi as hass
import datetime
##############################################################################################
# Args:
#
# sensor: binary sensor to use as trigger. several motion detectors are seperated with ,
# entity_on : entity to turn on when detecting motion, can be a light, script, scene or anything else that can be turned on. more lights are sepetated with ,
# entity_off : entity to turn off when detecting motion, can be a light, script or anything else that can be turned off. Can also be a scene which will be turned on. more lights are sepetated with ,
# delay: amount of time after turning on to turn off again. If not specified defaults to 60 seconds.
# start_time: time of day to start doing motion
# end_time: time of day to stop doing motion
#
# Release Notes
#
# Version 1.5:
#   Added day/night stuff. All my lights are either motion at night only or motion all the time with different scenes for day/night.
# Version 1.4:
#   Added option to use lux reading from a sensor instead of constraint time
# Version 1.3:
#   Added ability for light to stay on once triggered until end constraint time
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

class MotionLights(hass.Hass):

  def initialize(self):
    
    self.handle = None
    self.we_turned_on = False
    self.day_to_night = None
    self.night_to_day = None
    
    if "sensor" in self.args:
      self.sensors = self.args["sensor"].split(",")
      for sensor in self.sensors:
        self.listen_state(self.motion, sensor)
    else:
      self.log("No sensor specified, doing nothing")
    
  def should_trigger(self):
    # should we be doing this?
    if self.get_state("input_boolean.detect_motion") == "off":
      self.log("not detecting motion")
      self.log(self.get_state("input_boolean.detect_motion"))
      return False

    sleeping = self.get_state("input_boolean.sleeping") == "on"
    if sleeping and self.args.get("ignore_if_sleeping", False):
      #self.log("rule requires not sleeping and sleep is on, so ignoring")
      return False

    oliver_home = self.get_state("input_boolean.oliver_home") == "on"
    if oliver_home and self.args.get("require_oliver_gone", False):
      self.log("rule requires oliver to be gone and he isn't, ignoring")
      return False

    if not oliver_home and self.args.get("require_oliver_home", False):
      self.log("rule required oliver to be home and he isn't, ignoring")
      return False

    lux_override = False
    if "lux_sensor" in self.args and "min_lux" in self.args:
      lux_reading = self.get_state(self.args.get("lux_sensor"))
      lux_override = int(lux_reading) < int(self.args.get("min_lux"))
      if lux_override:
        self.log("Lux level is too low(" + str(int(lux_reading)) +") - '" + lux_reading + "', overiding the time")

    if not lux_override:
      if "start_time" in self.args and "end_time" in self.args and not self.now_is_between(self.args["start_time"], self.args["end_time"]):
          self.log("not running rule because of time constraints")
          return False
    return True

  def turn_entity_on(self, entity):
    on_entities = entity.split(",")
    for on_entity in on_entities:
      self.turn_on(on_entity)

  def turn_entity_off(self, entity):
    off_entities = entity.split(",")
    for off_entity in off_entities:
      # If it's a scene we need to turn it on not off
      device, entity = self.split_entity(off_entity)
      if device == "scene":
        self.log("I activated {}".format(off_entity))
        self.turn_on(off_entity)
      else:
        self.log("I turned {} off".format(off_entity))
        self.turn_off(off_entity)

  def swap_from_day_to_night(self, kwargs):
    if "entity_on_night" in self.args and self.handle:
      self.turn_entity_on(self.args["entity_on_night"])
    else:
      if "entity_off_night" in self.args:
        self.turn_entity_on(self.args['entity_off_night'])
      
  def swap_from_night_to_day(self, kwargs):
    if "entity_on" in self.args and self.handle:
      self.turn_entity_on(self.args["entity_on"])

  def motion(self, entity, attribute, old, new, kwargs):
    # first thing, if the light is on now, we just take our hands off
    # if not self.we_turned_on and self.args.get("ignore_if_on", False) and self.get_state(self.args["entity_on"]) == "on":
    #  self.log("someone else has this light on, so we don't care about the motion")
    #  return

    # first, should we listen
    if not self.should_trigger():
      return

    # second, what to we poke
    entity_on_str = "entity_on"
    if "entity_on_night" in self.args:
      night_offset = self.args.get("swap_to_night_offset", 0)
      day_offset = self.args.get("swap_to_day_offset", 0)
      if self.now_is_between('sunset {}00:{:02}:00'.format('-' if night_offset < 0 else '+', abs(night_offset)), "sunrise {}00:{:02}:00".format('-' if day_offset < 0 else '+', abs(day_offset))):
        entity_on_str = "entity_on_night"

      # ensure we have a timer for the transitions between night and day
      if self.day_to_night == None:
        self.day_to_night = self.run_at_sunset(self.swap_from_day_to_night, offset = datetime.timedelta(minutes = night_offset).total_seconds())
      if self.night_to_day == None:
        self.night_to_day = self.run_at_sunrise(self.swap_from_night_to_day, offset = datetime.timedelta(minutes = day_offset).total_seconds())

    delay = self.args.get("delay", None)
    end_time = self.args.get("end_time", None)
    
    # maybe munge the delay
    if delay == None and lux_override:
      delay = 1800

    if delay == None and end_time != None and self.handle != None:
      self.handle = self.run_once(self.light_off, end_time)

    if new == "on" or new == "open" or new == "motion detected" or new == "motion":
      if self.handle == None:
        if entity_on_str in self.args:
          self.turn_entity_on(self.args[entity_on_str])
          self.log("First motion detected: i turned {} on, and did set timer".format(self.args[entity_on_str]))
        else:
          self.log("First motion detected: i turned nothing on, but did set timer")          
        self.we_turned_on = True
        if delay != None:
          self.handle = self.run_in(self.light_off, delay)
        else:
          end_time = self.args.get("end_time", None)
          if delay == None and end_time != None:
            self.handle = self.run_once(self.light_off, end_time)
      elif delay != None:
        self.cancel_timer(self.handle)
        self.handle = self.run_in(self.light_off, delay)
        self.log("Motion detected again, i have reset the timer")
  
  def light_off(self, kwargs):
    motion_still_detected = False
    for sensor in self.sensors:
      st = self.get_state(sensor)
      if st == "on" or st == "open" or st == "motion detected" or st == "motion":
        motion_still_detected = True
    if not motion_still_detected:
      self.handle = None
      entity_off_str = "entity_off"
      if "entity_off_night" in self.args:
        night_offset = self.args.get("swap_to_night_offset", 0)
        day_offset = self.args.get("swap_to_day_offset", 0)
        if self.now_is_between('sunset {}00:{:02}:00'.format('-' if night_offset < 0 else '+', abs(night_offset)), "sunrise {}00:{:02}:00".format('-' if day_offset < 0 else '+', abs(day_offset))):
          entity_off_str = "entity_off_night"

      if entity_off_str in self.args:
        self.turn_entity_off(self.args[entity_off_str])
      self.we_turned_on = False
    else:
      self.handle = self.run_in(self.light_off, self.args.get("delay", 60))
      self.log("Motion still detected at end of delay, reseting delay")
