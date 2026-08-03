import appdaemon.plugins.hass.hassapi as hass
import statistics
import time
##############################################################################################
# Args:
#
# fan: switch entity for the exhaust fan
# fan_sensor: humidity sensor inside the bathroom
# light (optional): light to toggle with the fan
# override (optional): input_boolean that suspends fan control while "on"
# occupancy_entity: input_select published by RoomOccupancy (Occupied/Pending Exit/Empty)
# shower_spike_pp: humidity rise (pp) above the window median that counts as a
#                  shower starting (default 12)
# shower_spike_seconds: rolling window for shower detection (default 180)
# post_exit_minutes: fan runtime after the bathroom empties (default 15)
# max_runtime_minutes: absolute cap on a session regardless of occupancy (default 60)
# notify (optional): HA notify service name (e.g. "mikeandjolei") to remind
#                    when an override leaves the fan running past the session
# override_notify_minutes: delay after an override-abandoned session before the
#                          reminder fires, if the fan is still on (default 60)
# timed_button (optional): input_button that starts a fixed-length run
# timed_minutes: how long a timed run lasts (default 30)
#
# Release Notes
#
# Version 2.3:
#   Timed runs. Pressing timed_button runs the fan for timed_minutes flat:
#   occupancy is ignored (no 15-min empty-room tail cutting it short) and the
#   fan turns off when the timer fires. Pressing again restarts the clock. A
#   shower detected mid-run hands control back to the occupancy session logic.
#   Motivated by the humidity sensor under-reading a real shower (2026-08-03):
#   a guaranteed manual run needs to exist that no sensor can veto.
# Version 2.2:
#   Override sessions never auto-off by design, which let a wall-switch press
#   run the fan for 12+ hours unnoticed. Now, when a session ends but the
#   override leaves the fan running, a reminder timer starts; if the fan is
#   still on when it fires, send a notification with the total runtime.
#   Turning the fan off (any way) cancels the reminder.
# Version 2.1:
#   Spikes are measured against the MEDIAN of the rolling window, not the
#   minimum. Comparing against the min made every dip-then-rebound (AC blast,
#   door swing) look like a shower: the bounce off the bottom of the V read as
#   an 8pp rise. A real shower is a 30-40pp climb off a flat baseline — vs the
#   median it towers over rebound noise (~9pp max observed). Threshold up to
#   12pp accordingly, and detection now waits for the window to have enough
#   coverage (5+ samples spanning a third of the window) before judging.
# Version 2.0:
#   Occupancy-session model. A shower-sized humidity spike while the bathroom is
#   occupied starts a session: fan runs while occupied, then for post_exit_minutes
#   after the room empties (re-entry cancels the tail timer; the next exit restarts
#   it). max_runtime_minutes bounds the session as a backstop. No comparison sensor,
#   no differential math: on humid days the replacement air is as wet as the bath
#   air, so long differential-driven runs only exhaust conditioned air. The fan
#   knocks down the steam burst and the AC equalizes the rest. A fan turned on
#   outside the app (switch/override) is adopted as a session so it still auto-off.
# Version 1.3:
#   fan_offset only applied for spike_window_minutes after the last detected spike.
# Version 1.2:
#   Added fan_offset to compensate for fan airflow affecting humidity sensor
#   Fixed crash when sensors report "unavailable"
# Version 1.1:
#   Added a light to optionally turn on
# Version 1.0:
#   Initial Version (aimc)

class BathFan(hass.Hass):
  def initialize(self):
    self.spike_pp = float(self.args.get("shower_spike_pp", 12))
    self.spike_window = float(self.args.get("shower_spike_seconds", 180))
    self.post_exit_s = float(self.args.get("post_exit_minutes", 15)) * 60
    self.max_runtime_s = float(self.args.get("max_runtime_minutes", 60)) * 60
    self.notify_after_s = float(self.args.get("override_notify_minutes", 60)) * 60
    self.timed_s = float(self.args.get("timed_minutes", 30)) * 60

    self.history = []
    self.session_active = False
    self.exit_handle = None
    self.max_handle = None
    self.notify_handle = None
    self.timed_handle = None
    self.fan_on_since = None

    self.listen_state(self.humidity_change, self.args["fan_sensor"])
    self.listen_state(self.occupancy_change, self.args["occupancy_entity"])
    self.listen_state(self.fan_change, self.args["fan"])
    if 'timed_button' in self.args:
      self.listen_state(self.timed_press, self.args["timed_button"])

    self.log("Bath fan v2.3 watching {} (spike {}pp over median/{}s, tail {}min, max {}min, occupancy {})".format(
        self.args["fan_sensor"], self.spike_pp, int(self.spike_window),
        int(self.post_exit_s / 60), int(self.max_runtime_s / 60),
        self.args["occupancy_entity"]))

    # Adopt a fan that is already running (AppDaemon restart mid-session).
    if self.get_state(self.args["fan"]) == "on":
      self.log("Fan already on at startup - adopting session")
      self.fan_on_since = time.time()
      self.start_session(adopted=True)

  def override_on(self):
    return 'override' in self.args and self.get_state(self.args["override"]) == "on"

  def occupied(self):
    return self.get_state(self.args["occupancy_entity"]) != "Empty"

  def cancel(self, handle):
    if handle is not None:
      self.cancel_timer(handle)
    return None

  # --- shower detection -----------------------------------------------------

  def humidity_change(self, entity, attribute, old, new, kwargs):
    try:
      val = float(new)
    except (ValueError, TypeError):
      return
    now = time.time()
    self.history = [(ts, v) for ts, v in self.history if now - ts <= self.spike_window]

    # Baseline is the window MEDIAN: robust against the dip-then-rebound
    # pattern (AC blast, door swing) that a min-based baseline mistakes for a
    # shower. Judge only once the window has real coverage, so a restart or
    # sensor gap can't fire off two samples.
    baseline = None
    if len(self.history) >= 5 and now - self.history[0][0] >= self.spike_window / 3:
      baseline = statistics.median(v for _, v in self.history)

    self.history.append((now, val))
    if baseline is None or val - baseline < self.spike_pp:
      return

    if not self.occupied():
      # AC blowing saturated air around an empty bathroom is not a shower.
      return
    if self.override_on():
      self.log("Shower spike {} -> {} ignored: override set".format(baseline, val))
      return

    if not self.session_active:
      self.log("Shower detected: {} above window median {}".format(val, baseline))
      self.start_session()
    elif self.timed_handle is not None:
      # A real shower outranks the fixed clock: let occupancy govern from here.
      self.log("Shower detected during timed run - switching to occupancy session")
      self.start_session(adopted=True)
    elif self.exit_handle is not None:
      # Steam while the tail timer runs means someone is showering again.
      self.log("Shower spike during tail - cancelling exit timer")
      self.exit_handle = self.cancel(self.exit_handle)

  # --- session lifecycle ----------------------------------------------------

  def start_session(self, adopted=False, timed=False):
    self.session_active = True
    self.exit_handle = self.cancel(self.exit_handle)
    self.max_handle = self.cancel(self.max_handle)
    self.notify_handle = self.cancel(self.notify_handle)
    self.timed_handle = self.cancel(self.timed_handle)
    if timed:
      # Fixed-length run: no occupancy tail, no max backstop - just the clock.
      self.turn_on(self.args["fan"])
      self.timed_handle = self.run_in(self.timed_done, self.timed_s)
      return
    self.max_handle = self.run_in(self.max_runtime_reached, self.max_runtime_s)
    if not adopted:
      self.turn_on(self.args["fan"])
      if 'light' in self.args:
        self.turn_on(self.args["light"])
    if not self.occupied():
      self.log("Bathroom already empty - starting {:.0f}min tail".format(self.post_exit_s / 60))
      self.exit_handle = self.run_in(self.exit_timer_done, self.post_exit_s)

  def end_session(self, reason):
    self.exit_handle = self.cancel(self.exit_handle)
    self.max_handle = self.cancel(self.max_handle)
    self.timed_handle = self.cancel(self.timed_handle)
    self.session_active = False
    if self.override_on():
      self.log("Session over ({}) but override set - leaving fan alone".format(reason))
      if 'notify' in self.args:
        self.notify_handle = self.cancel(self.notify_handle)
        self.notify_handle = self.run_in(self.override_reminder, self.notify_after_s)
      return
    self.log("Turning fan off ({})".format(reason))
    self.turn_off(self.args["fan"])
    if 'light' in self.args:
      self.turn_off(self.args["light"])

  def occupancy_change(self, entity, attribute, old, new, kwargs):
    if not self.session_active:
      return
    if self.timed_handle is not None:
      # Timed runs ignore occupancy entirely; the clock is the only authority.
      return
    if new == "Empty":
      self.log("Bathroom empty - fan off in {:.0f}min unless someone returns".format(self.post_exit_s / 60))
      self.exit_handle = self.cancel(self.exit_handle)
      self.exit_handle = self.run_in(self.exit_timer_done, self.post_exit_s)
    else:
      if self.exit_handle is not None:
        self.log("Bathroom re-occupied - tail timer cancelled")
        self.exit_handle = self.cancel(self.exit_handle)

  def fan_change(self, entity, attribute, old, new, kwargs):
    if new == "on":
      if self.fan_on_since is None:
        self.fan_on_since = time.time()
      if not self.session_active:
        self.log("Fan turned on externally - adopting session")
        self.start_session(adopted=True)
    elif new == "off":
      self.fan_on_since = None
      self.notify_handle = self.cancel(self.notify_handle)
      if self.session_active:
        self.log("Fan turned off externally - ending session")
        self.exit_handle = self.cancel(self.exit_handle)
        self.max_handle = self.cancel(self.max_handle)
        self.timed_handle = self.cancel(self.timed_handle)
        self.session_active = False

  def timed_press(self, entity, attribute, old, new, kwargs):
    if new in (None, "unavailable", "unknown"):
      return
    if self.override_on():
      self.log("Timed run requested but override set - ignoring")
      return
    self.log("Timed run: fan on for {:.0f}min".format(self.timed_s / 60))
    self.start_session(timed=True)

  def timed_done(self, kwargs):
    self.timed_handle = None
    self.end_session("timed {:.0f}min run complete".format(self.timed_s / 60))

  def exit_timer_done(self, kwargs):
    self.exit_handle = None
    self.end_session("post-exit tail expired")

  def max_runtime_reached(self, kwargs):
    self.max_handle = None
    self.end_session("max runtime {:.0f}min reached".format(self.max_runtime_s / 60))

  def override_reminder(self, kwargs):
    self.notify_handle = None
    if self.get_state(self.args["fan"]) != "on":
      return
    hours = (time.time() - self.fan_on_since) / 3600 if self.fan_on_since else 0
    self.log("Override fan still running {:.1f}h in - sending reminder".format(hours))
    self.call_service(
        "notify/" + self.args["notify"],
        title="Bath fan still running",
        message="{} has been on for {:.1f} hours (manual override) and will not "
                "turn off on its own.".format(self.friendly_name(self.args["fan"]), hours))
