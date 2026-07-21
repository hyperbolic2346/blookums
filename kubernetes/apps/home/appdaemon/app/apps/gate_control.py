import appdaemon.plugins.hass.hassapi as hass

#
# App to send notification when motion detected
#
# Args:
#
# devices_to_watch: devices used to turn off detection if home
#
# Release Notes
#
# Version 1.0:
#   Initial Version

class GateControl(hass.Hass):

  def initialize(self):
    self.listen_state(self.gate, "device_tracker.mikes_iphone")
    self.listen_state(self.gate, "device_tracker.joannas_iphone")
    self.opened_gate = False

  def gate(self, entity, attribute, old, new, kwargs):
    if old.lower() == new.lower():
      return

    self.log("Got {} going from {} to {}".format(self.friendly_name(entity), old, new));
    if old.lower() == "gate":
      if self.opened_gate == False:
        self.log("Someone left the gate, but I didn't open it so I'm ignoring it.")
        return

      self.turn_off("switch.wilson_gate")
      self.log("closing the gate")
      self.opened_gate = False

    elif new.lower() == "gate":
      if self.get_state("switch.wilson_gate") == "on": 
        # gate already open, don't mess with it
        self.log("Someone is at the gate, but it is already open, so I'm not going to mess with it.")
        return

      self.turn_on("switch.wilson_gate")
      self.log("opening the gate")
      self.opened_gate = True
