import appdaemon.plugins.hass.hassapi as hass

#
# App to send notification when glass break detected
#
# Args:
#
# sensor: sensor to monitor e.g. input_binary.hall
#
# Release Notes
#
# Version 1.0:
#   Initial Version

class GlassNotification(hass.Hass):

  def initialize(self):
    if "sensor" in self.args:
      for sensor in self.split_device_list(self.args["sensor"]):
        self.listen_state(self.breakage, sensor)
    else:
      self.listen_state(self.breakage, "binary_sensor")

  def breakage(self, entity, attribute, old, new, kwargs):
    if ("state" in new and (new["state"] == "on" or new["state"] == "open") and (old["state"] == "off" or old["state"] == "closed")) or new == "on":
      self.log("Glass break detected: {}".format(self.friendly_name(entity)))
      self.notify("Glass break detected: {}".format(self.friendly_name(entity)))
