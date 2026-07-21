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
# Version 2.0:
#   Adding arbitrary numbers of transitions during the day at specific times such as sunrise, sunset, midnight
#   Config would look something like:
#     transitions:
#       name1:
#         turn_on: scene.morning_motion
#         turn_off: scene.morning
#         start_time: sunrise
#       name2:
#         turn_on: scene.afternoon_motion
#         turn_off: switch.livingroom
#         start_time: 12:00
#       name3:
#         turn_on: scene.night_motion
#         turn_off: scene.night
#         start_time: sunset
#       name4:
#         turn_on: switch.livingroom
#         turn_off: switch.livingroom
#         start_time: 00:00
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

  def get_transition_time(self, transition):
    run_time = self.parse_time(transition['start_time'])
    run_datetime = datetime.datetime.combine(datetime.date.today(), run_time)
    if run_datetime < self.datetime():
      run_datetime = datetime.datetime.combine(datetime.date.today() + datetime.timedelta(days=1), run_time)
    self.log("Next transition time is {}".format(run_datetime))
    return run_datetime

  def find_current_transition(self):
    if len(self.args['transitions']) == 1:
      self.log("Just one transition, setting it to {}".format(self.args['transitions'][0]))
      return self.args['transitions'][0]

    previous_transition = self.args['transitions'][-1]
    for transition in self.args['transitions']:
      if self.now_is_between(previous_transition['start_time'], transition['start_time']):
        # time between last one and this one, we're doing the last one currently, but need to schedule
        # this one for the future at start_time
        return previous_transition
      previous_transition = transition

    self.log("unable to find transition!")
    return None


  def next_transition(self, transition):
    next_transition_index = self.args['transitions'].index(transition) + 1
    if next_transition_index >= len(self.args['transitions']):
      next_transition_index = 0
    self.log("next transition index is {}".format(next_transition_index))
    self.log("this makes it {}".format(self.args['transitions']))
    return self.args['transitions'][next_transition_index]


  def initialize(self):
    
    self.handle = None
    self.we_turned_on = False
    self.next_transition_timer = None
    self.current_transition = None

    # listen to all the sensors
    if "sensor" in self.args:
      self.sensors = self.args["sensor"].split(",")
      for sensor in self.sensors:
        self.listen_state(self.motion, sensor)
    else:
      self.log("No sensor specified, doing nothing")

    #self.log('transitions is a {}'.format(type(self.args['transitions'])))
    #self.log('{}'.format(self.args['transitions']))
    self.current_transition = self.find_current_transition()
    if len(self.args['transitions']) == 1:
        self.turn_entity_off()
        return

    # start a timer for next transition
    next_transition = self.next_transition(self.current_transition)
    run_datetime = self.get_transition_time(next_transition)
    self.log("Next transition: - {}".format(next_transition))
    self.next_transition_timer = self.run_at(self.transition, run_datetime, next_transition = next_transition)
    self.turn_entity_off()


  def transition(self, kwargs):
    # transition to the kwargs['next_transition'] state
    self.log("transitioning to next transition, which is {}".format(kwargs['next_transition']))
    self.current_transition = kwargs['next_transition']

    if self.handle and self.current_transition['turn_on'] is not None:
      # currently "on"
      self.turn_entity_on()
    else:
      self.turn_entity_off()

    # set timer for next transition
    next_transition = self.next_transition(self.current_transition)
    self.log("Next transition: {}".format(next_transition))
    run_datetime = self.get_transition_time(next_transition)
    self.next_transition_timer = self.run_at(self.transition, run_datetime, next_transition = next_transition)


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

    if not self.current_transition:
        self.current_transition = self.find_current_transition()
    if self.current_transition['turn_on'] == "None":
        return False

    return True


  def turn_entity_on(self):
    if not self.current_transition:
      self.current_transition = self.find_current_transition()
    self.log("current transition is {}".format(self.current_transition))
    on_entities = self.current_transition['turn_on'].split(",")
    for on_entity in on_entities:
      self.turn_on(on_entity)


  def turn_entity_off(self, override_entity = None):
    if override_entity != None:
      off_entities = override_entity.split(",")
    else:
      if not self.current_transition:
        self.current_transition = self.find_current_transition()
      off_entities = self.current_transition['turn_off'].split(",")
    for off_entity in off_entities:
      # If it's a scene we need to turn it on not off
      device, entity = self.split_entity(off_entity)
      if device == "scene":
        self.log("I activated {}".format(off_entity))
        self.turn_on(off_entity)
      else:
        self.log("I turned {} off".format(off_entity))
        self.turn_off(off_entity)

  def motion(self, entity, attribute, old, new, kwargs):
    # first thing, if the light is on now, we just take our hands off
    # if not self.we_turned_on and self.args.get("ignore_if_on", False) and self.get_state(self.args["entity_on"]) == "on":
    #  self.log("someone else has this light on, so we don't care about the motion")
    #  return

    # first, should we listen
    if not self.should_trigger():
      return

    delay = self.args.get("delay", None)
    
    # maybe munge the delay
    if delay == None and lux_override:
      delay = 1800

    if new == "on" or new == "open" or new == "motion detected" or new == "motion":
      if self.handle == None:
        # new motion, turn on
        self.turn_entity_on()
        if not self.current_transition:
          self.current_transition = self.find_current_transition()
        if self.current_transition['turn_on']:
          self.log("First motion detected: i turned {} on, and did set timer".format(self.current_transition['turn_on']))
        else:
          self.log("First motion detected: i turned nothing on, but did set timer")          
        self.we_turned_on = True
        if delay != None:
          self.handle = self.run_in(self.light_off, delay)
        # transition will handle turning this off if we have no handle set
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
      self.turn_entity_off()
      self.we_turned_on = False
    else:
      self.handle = self.run_in(self.light_off, self.args.get("delay", 60))
      self.log("Motion still detected at end of delay, reseting delay")
