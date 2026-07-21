import appdaemon.plugins.hass.hassapi as hass

#
# App to send notification when motion detected
#
# Args:
#
# sensor: sensor to monitor e.g. input_binary.hall
# devices_to_watch: devices used to turn off detection if home
#
# Release Notes
#
# Version 1.0:
#   Initial Version

class MotionNotification(hass.Hass):

  def initialize(self):
    if "sensor" in self.args:
      for sensor in self.split_device_list(self.args["sensor"]):
        self.listen_state(self.motion, sensor)
    else:
      self.listen_state(self.motion, "binary_sensor")

  def motion(self, entity, attribute, old, new, kwargs):
    if not self.get_state("input_boolean.alert_motion"):
      return

    if self.get_state("input_boolean.guests"):
      return

    if "devices_to_watch" in self.args:
      devices = self.args["devices_to_watch"].split(",")
      for device in devices:
        if device == "home" or device == "office":
          return

    if ("state" in new and (new["state"] == "on" or new["state"] == "open") and (old["state"] == "off" or old["state"] == "closed")) or new == "on":
      self.log("Motion detected: {}".format(self.friendly_name(entity)))
      self.notify("Motion detected: {}".format(self.friendly_name(entity)))
