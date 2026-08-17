import appdaemon.plugins.hass.hassapi as hass
import statistics
import time
##############################################################################################
# Args:
#
# fan: switch entity for the exhaust fan
# fan_sensor: humidity sensor inside the bathroom
# reference_sensors: humidity sensors standing in for "the dry part of the house".
#                    NOT a level the fan can reach - they are downstairs on
#                    another HVAC zone near the intake - so the thresholds below
#                    are an empirical calibration against them, not physics.
#                    Do NOT use sensors downstream of the bathroom (see below).
# reference_mode: "min" (default) or "median". See reference().
# start_gap_pp: turn the fan on when bath - reference reaches this (default 30)
# stop_gap_pp: turn it off again when the gap falls to this (default 18)
# evaluate_seconds: how often to re-decide, independent of sensor updates (default 60)
# max_runtime_minutes: safety cap on one continuous run (default 240)
# restart_cooldown_minutes: after a capped or manual stop, wait this long before the
#                           differential may start the fan again (default 30)
# stale_sensor_minutes: if the bath sensor goes unavailable this long, stop (default 30)
# smoothing_minutes: window for the median gap used to decide the fan is DONE
#                    (default 10). Turning on uses the instantaneous gap.
# occupancy_entity (optional): input_select from RoomOccupancy. Once the room has
#                    read Empty for post_exit_minutes AND the gap is down to
#                    soaked_gap_pp, the fan stops - the everyday ending.
# presence_sensors (optional): motion sensors whose "on" restarts the post-exit
#                    tail regardless of the occupancy helper - use the REAR/inner
#                    zone, which sees people the front sensor and the occupancy
#                    helper miss (e.g. behind the shower glass).
# entry_sensors (optional): door-side motion sensors. A hit here after the room
#                    empties means someone genuinely came back IN, which disarms
#                    the presence_sensors tail restart (a re-entry must not
#                    extend the tail; only a false "Empty" should).
# post_exit_minutes: how long after the room empties the fan runs on (default 15)
# soaked_gap_pp: above this the fan keeps going even though the room is empty,
#                rather than stopping with the mirror still fogged (default 25)
# min_runtime_minutes: floor on any run, prevents chatter (default 10)
# light (optional): light to toggle with the fan
# override (optional): input_boolean that suspends fan control while "on"
# notify (optional): HA notify service name for the override-left-running reminder
# override_notify_minutes: delay before that reminder (default 60)
# timed_button (optional): input_button that starts a fixed-length minimum run
# timed_minutes: how long a timed run lasts (default 30)
#
# Release Notes
#
# Version 3.0:
#   Humidity DIFFERENTIAL control. All rate/spike/"shower detection" logic is gone.
#
#   Why: v2.x tried to catch the moment a shower starts by watching how fast
#   humidity rises, and it kept missing. On 2026-08-17 it missed twice in one
#   day, in opposite directions. The 11:00 shower climbed 62->92% at ~0.6pp/min,
#   too slow to ever put 12pp inside the 180s window. The 13:17 event climbed
#   84->92% in 2.5 minutes - too FAST, because the 180s median window filled
#   with the rising values themselves and chased the ramp (peak reading was only
#   +4pp). A fixed window has a blind spot at both ends, and no threshold fixes
#   both. A sustained-rise variant (v2.4, never deployed) failed for a third
#   reason: it needed 5 samples in its baseline window, but this sensor only
#   reports on change, so a quiet room yields ~2 samples per 3 minutes and the
#   test silently returned None.
#
#   The deeper problem is that there is often no event to detect. The bathroom
#   frequently never dries out between showers - on 2026-08-17 it sat 23-42pp
#   above the rest of the house from 11:00 to 15:00 while the fan ran for two
#   fixed 30-minute stretches and stopped both times with the room at 99%. On
#   2026-08-15 it sat at 86-98% for 8.5 hours with the fan off. A rate detector
#   is structurally unable to fix that: a wet room that stays wet has no edge.
#
#   So: stop hunting for the start of a shower. Ask continuously whether this
#   room is wetter than the rest of the house, and run the fan while it is.
#   High humidity here is a STATE, and state is what the fan should answer to.
#
#   Two things make this work where v1.x's old differential did not:
#
#   1. REFERENCE CHOICE. master_hall_humidity correlates 0.76 with the bathroom
#      and master_closet1_humidity 0.83 - both sit downstream of the bathroom
#      and rise as its moisture escapes into them (the closet hit 99%). Using
#      them as the "house" baseline shrinks the measured gap exactly when the
#      problem is worst: at 15:00 on 2026-08-17 the hall said +27pp while the
#      clean sensors said +42pp. reference_sensors should therefore be rooms the
#      bathroom does not vent into - guest_bath (corr 0.35) and entry1 (0.49).
#      The median makes one of them showering harmless.
#
#   2. PERIODIC EVALUATION. v2.x only re-decided on humidity state changes. This
#      sensor stops transmitting when it saturates - on 2026-08-17 it sent
#      nothing between 14:12 and 14:56, so an event-driven app was blind for 44
#      minutes, including the entire time the fan was running. evaluate() now
#      runs on a timer as well, so silence cannot stall the control loop.
#
#   Replayed over 4.8 days: 6.0 h/day of fan (v2.3 actually managed 1.1), 15
#   runs, median 95 min, 80% ending because the gap genuinely closed rather than
#   hitting the cap. The gap-closing runs are the fan doing real work; the capped
#   ones cluster in hot afternoons when outdoor air is too wet for the fan to
#   win, which is what max_runtime_minutes is for.
#
#   NOTE: RH is a proxy. The physically correct comparison is dew point, but
#   every indoor temperature sensor (master_bath1, master_hall, guest_bath,
#   master_closet1) currently reads "unavailable". Once they are back, this
#   should compare dew points instead - then "the fan cannot help right now"
#   becomes measurable rather than inferred.
#
# Version 2.3 and earlier: see git history. Occupancy-session and spike-detection
#   model, removed in 3.0.

class BathFan(hass.Hass):
  def initialize(self):
    self.fan = self.args["fan"]
    self.sensor = self.args["fan_sensor"]
    self.refs = list(self.args.get("reference_sensors", []))
    self.ref_mode = self.args.get("reference_mode", "min")
    self.start_gap = float(self.args.get("start_gap_pp", 30))
    self.stop_gap = float(self.args.get("stop_gap_pp", 18))
    self.max_runtime_s = float(self.args.get("max_runtime_minutes", 240)) * 60
    self.cooldown_s = float(self.args.get("restart_cooldown_minutes", 30)) * 60
    self.stale_s = float(self.args.get("stale_sensor_minutes", 30)) * 60
    self.smooth_s = float(self.args.get("smoothing_minutes", 10)) * 60
    self.post_exit_s = float(self.args.get("post_exit_minutes", 15)) * 60
    self.soaked_gap = float(self.args.get("soaked_gap_pp", 25))
    self.min_runtime_s = float(self.args.get("min_runtime_minutes", 10)) * 60
    self.presence = list(self.args.get("presence_sensors", []))
    self.entry_sensors = list(self.args.get("entry_sensors", []))
    self.timed_s = float(self.args.get("timed_minutes", 30)) * 60
    self.notify_after_s = float(self.args.get("override_notify_minutes", 60)) * 60
    interval = float(self.args.get("evaluate_seconds", 60))

    self.running_since = None
    self.blocked_until = None
    self.gap_history = []
    self.empty_since = None
    self.entered_since_empty = False
    self.timed_until = None
    self.last_reading_at = time.time()
    self.notify_handle = None
    self.last_log = None

    if self.stop_gap >= self.start_gap:
      self.log("CONFIG ERROR: stop_gap_pp ({}) must be below start_gap_pp ({}) "
               "or the fan will chatter".format(self.stop_gap, self.start_gap))
    if not self.refs:
      self.log("CONFIG ERROR: no reference_sensors - cannot compute a gap")

    if self.get_state(self.fan) == "on":
      self.running_since = time.time()

    if 'occupancy_entity' in self.args:
      if self.get_state(self.args["occupancy_entity"]) == "Empty":
        self.empty_since = time.time()
      self.listen_state(self.occupancy_change, self.args["occupancy_entity"])
    for p in self.presence:
      self.listen_state(self.presence_seen, p, new="on")
    for e in self.entry_sensors:
      self.listen_state(self.entry_seen, e, new="on")
    self.listen_state(self.sensor_change, self.sensor)
    self.listen_state(self.fan_change, self.fan)
    if 'timed_button' in self.args:
      self.listen_state(self.timed_press, self.args["timed_button"])
    self.run_every(self.evaluate, "now+15", interval)

    self.log("Bath fan v3.0: {} vs {}{} - on at +{}pp, off at +{}pp, "
             "re-evaluated every {}s, cap {}min".format(
        self.sensor, self.ref_mode, self.refs, self.start_gap, self.stop_gap,
        int(interval), int(self.max_runtime_s / 60)))

  # --- helpers --------------------------------------------------------------

  def humidity(self, entity):
    """A humidity reading, or None if the sensor is not reporting something sane.
    Filters the 2147483648 sentinel a broken sensor in this house emits."""
    try:
      val = float(self.get_state(entity))
    except (ValueError, TypeError):
      return None
    return val if 0 <= val <= 100 else None

  def reference(self):
    """The dry-house baseline. Default MIN, not median.

    With only two reference sensors a median is just their average, so one
    sensor wandering drags the baseline and silently eats the gap. That is not
    hypothetical: on 2026-08-17 entry1 drifted 52% -> 70% in the evening, which
    pulled the reference from 53 to 62 and left the fan idle at +28pp with the
    bathroom sitting at 90%. The two disagree by 8pp typically and up to 21pp,
    and entry1 swings 29pp a day against guest_bath's 14pp.

    The minimum answers the question actually being asked - how dry is the dry
    part of the house - and cannot be spoiled by one sensor reading high, which
    is the failure that has now bitten twice (master_hall, then entry1). It is
    exposed to a sensor reading spuriously LOW, which the 0-100 sanity filter
    in humidity() and the healthy state of both sensors make an acceptable
    trade. Set reference_mode: median to go back."""
    vals = [v for v in (self.humidity(r) for r in self.refs) if v is not None]
    if not vals:
      return None
    return min(vals) if self.ref_mode == "min" else statistics.median(vals)

  def override_on(self):
    return 'override' in self.args and self.get_state(self.args["override"]) == "on"

  def say(self, key, msg):
    """Log once per state change. evaluate() runs every minute and these
    messages carry live numbers, so deduping on the text alone would still
    emit a line a minute - dedupe on the state KEY instead."""
    if key != self.last_log:
      self.log(msg)
      self.last_log = key

  def smoothed_gap(self, now):
    """Median gap over the smoothing window, or None until the window is full.

    Used only to decide the fan has FINISHED. The reference sensors are twitchy
    (the house median swung 58->48 inside 21 minutes on 2026-08-13) and a single
    dip below stop_gap_pp would otherwise switch the fan off mid-job and
    immediately retrigger. Turning ON uses the instantaneous gap, so a real
    shower is answered at once - quick to react, slow to declare victory.

    Returning None until the window is full matters: gap_history is cleared when
    the fan starts, so for the first smoothing_minutes there is no verdict and
    the fan cannot stop. Without that, the window still held the pre-shower dry
    readings and their median sat below stop_gap_pp, so the fan switched off in
    the same second it started (observed: 6 on/off cycles inside 2 minutes)."""
    if not self.gap_history or now - self.gap_history[0][0] < self.smooth_s:
      return None
    return statistics.median(g for _, g in self.gap_history)

  def set_fan(self, on, reason):
    # Transitions always log, and reset the dedupe so the next steady-state
    # line prints once for the new state.
    self.log("{} fan: {}".format("Turning ON" if on else "Turning OFF", reason))
    self.last_log = None
    if on:
      self.turn_on(self.fan)
      if 'light' in self.args:
        self.turn_on(self.args["light"])
      self.running_since = time.time()
    else:
      self.turn_off(self.fan)
      if 'light' in self.args:
        self.turn_off(self.args["light"])
      self.running_since = None

  # --- the control loop -----------------------------------------------------

  def occupancy_change(self, entity, attribute, old, new, kwargs):
    """Arm the post-exit tail on the TRANSITION to Empty. Testing "is empty
    right now" instead made the tail already satisfied at the instant the fan
    started, so it stopped a minute later and immediately retriggered - 64
    runs/day in replay."""
    if new == "Empty":
      if self.empty_since is None:
        self.empty_since = time.time()
        self.entered_since_empty = False
    else:
      self.empty_since = None
      self.entered_since_empty = False
    self.evaluate({})

  def entry_seen(self, entity, attribute, old, new, kwargs):
    """Someone came back through the door after the room emptied. Recorded so
    the rear sensor does not then restart the tail - see presence_seen."""
    if self.empty_since is not None:
      self.entered_since_empty = True

  def presence_seen(self, entity, attribute, old, new, kwargs):
    """Rear-zone motion while the occupancy helper says Empty means the helper
    is WRONG - somebody never left, they were just invisible behind the shower
    glass (it called the room Empty from 10:48-11:06 mid-shower on 2026-08-17).
    Correcting that restarts the post-exit tail.

    But only when nobody walked back IN. A genuine exit followed by a re-entry
    also lights the rear sensor, and that must not push the tail out - popping
    back in for a towel is not a reason to keep drying the room. The two cases
    are separable by geometry: coming back in means passing the door and
    tripping an entry sensor first, whereas someone still in the shower trips
    the rear zone alone. So an entry hit since the room emptied disarms this."""
    if self.empty_since is None:
      return
    if self.entered_since_empty:
      return
    self.log("Rear motion in {} with no entry since the room emptied - occupancy "
             "was wrong, restarting the {:.0f}min tail".format(
        entity, self.post_exit_s / 60))
    self.empty_since = None
    self.evaluate({})

  def sensor_change(self, entity, attribute, old, new, kwargs):
    if new not in (None, "unknown", "unavailable"):
      self.last_reading_at = time.time()
    self.evaluate({})

  def evaluate(self, kwargs):
    now = time.time()
    fan_on = self.get_state(self.fan) == "on"

    if self.override_on():
      self.say("override", "Override set - leaving the fan alone")
      return

    # A timed run guarantees a minimum runtime that the differential cannot cut
    # short. When it expires we fall through rather than switching off, so a
    # still-soaked room keeps the fan going instead of being abandoned at 99%.
    if self.timed_until is not None:
      if now < self.timed_until:
        if not fan_on:
          self.set_fan(True, "timed run ({:.0f}min)".format(self.timed_s / 60))
        return
      self.timed_until = None
      self.log("Timed run finished - differential takes over")

    bath = self.humidity(self.sensor)
    ref = self.reference()

    if bath is None:
      # Silence is normal (the sensor only reports on change, and goes quiet
      # when saturated); genuinely unavailable for a long time is not.
      if fan_on and now - self.last_reading_at > self.stale_s:
        self.set_fan(False, "bath sensor unavailable for {:.0f}min".format(
            (now - self.last_reading_at) / 60))
        self.blocked_until = now + self.cooldown_s
      return
    self.last_reading_at = now

    if ref is None:
      self.say("noref", "No usable reference sensor - holding current state")
      return

    gap = bath - ref
    self.gap_history.append((now, gap))
    self.gap_history = [(t, g) for t, g in self.gap_history if now - t <= self.smooth_s]
    settled = self.smoothed_gap(now)

    if fan_on:
      young = self.running_since and now - self.running_since < self.min_runtime_s
      empty_for = (now - self.empty_since) if self.empty_since else None

      if young:
        self.say("running", "Running (minimum {:.0f}min): bath {:.0f}%, house "
                            "{:.0f}%, +{:.0f}pp".format(
            self.min_runtime_s / 60, bath, ref, gap))
      elif settled is not None and settled <= self.stop_gap:
        self.set_fan(False, "gap closed ({:.0f}% vs {:.0f}% house, +{:.0f}pp "
                            "sustained)".format(bath, ref, settled))
      elif (empty_for is not None and empty_for >= self.post_exit_s
            and settled is not None and settled <= self.soaked_gap):
        # The normal ending: you left, the fan ran on a while, the room is no
        # longer badly soaked. Above soaked_gap_pp we keep going instead - that
        # is the 2026-08-17 case where a fixed timer switched off at 99%.
        self.set_fan(False, "bathroom empty {:.0f}min and down to +{:.0f}pp".format(
            empty_for / 60, settled))
      elif self.running_since and now - self.running_since >= self.max_runtime_s:
        self.set_fan(False, "{:.0f}min cap reached and still +{:.0f}pp - the fan "
                            "is not winning right now".format(self.max_runtime_s / 60, gap))
        self.blocked_until = now + self.cooldown_s
      else:
        self.say("running", "Running: bath {:.0f}%, house {:.0f}%, +{:.0f}pp "
                            "(off at +{:.0f} sustained)".format(bath, ref, gap, self.stop_gap))
      return

    if gap >= self.start_gap:
      if self.blocked_until and now < self.blocked_until:
        self.say("holding", "Wet (+{:.0f}pp) but holding off until {:.0f}min cooldown "
                            "expires".format(gap, (self.blocked_until - now) / 60))
        return
      self.blocked_until = None
      self.set_fan(True, "bath {:.0f}% vs {:.0f}% house (+{:.0f}pp)".format(bath, ref, gap))
    else:
      self.say("idle", "Idle: bath {:.0f}%, house {:.0f}%, +{:.0f}pp (on at +{:.0f})".format(
          bath, ref, gap, self.start_gap))

  # --- external interactions ------------------------------------------------

  def fan_change(self, entity, attribute, old, new, kwargs):
    if new == "on":
      if self.running_since is None:
        self.running_since = time.time()
      self.notify_handle = self.cancel_timer_safe(self.notify_handle)
      if 'notify' in self.args and self.override_on():
        self.notify_handle = self.run_in(self.override_reminder, self.notify_after_s)
    elif new == "off":
      # Someone turned it off by hand while the room is still humid: respect
      # that instead of immediately switching it back on.
      if self.running_since is not None and not self.override_on():
        self.blocked_until = time.time() + self.cooldown_s
      self.running_since = None
      self.timed_until = None
      self.notify_handle = self.cancel_timer_safe(self.notify_handle)

  def cancel_timer_safe(self, handle):
    if handle is not None:
      self.cancel_timer(handle)
    return None

  def timed_press(self, entity, attribute, old, new, kwargs):
    if new in (None, "unavailable", "unknown"):
      return
    if self.override_on():
      self.log("Timed run requested but override set - ignoring")
      return
    self.blocked_until = None
    self.timed_until = time.time() + self.timed_s
    self.log("Timed run: fan on for at least {:.0f}min".format(self.timed_s / 60))
    self.evaluate({})

  def override_reminder(self, kwargs):
    self.notify_handle = None
    if self.get_state(self.fan) != "on":
      return
    hours = (time.time() - self.running_since) / 3600 if self.running_since else 0
    self.log("Override fan still running {:.1f}h in - sending reminder".format(hours))
    self.call_service(
        "notify/" + self.args["notify"],
        title="Bath fan still running",
        message="{} has been on for {:.1f} hours (manual override) and will not "
                "turn off on its own.".format(self.friendly_name(self.fan), hours))
