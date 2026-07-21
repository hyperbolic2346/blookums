import appdaemon.plugins.hass.hassapi as hass
import datetime

class NightLight(hass.Hass):

  def initialize(self):
    if "end_time" in self.args:
      end_time = self.parse_time(self.args["end_time"])
      self.run_daily(self.sunrise_cb, end_time)
      off_time = self.args["end_time"]
    else:
      off_time = 'sunrise'
      self.run_at_sunrise(self.sunrise_cb)
    self.run_at_sunset(self.sunset_cb)
    self.log('Setting up for sunset to {}'.format(off_time))
    if 'enable_switch' in self.args:
      if self.get_state(self.args['enable_switch']) == "off":
        return
    if self.now_is_between('sunset', off_time):
      self.turn_on(self.args['on_scene'])
      self.log('turning on {}'.format(self.args['on_scene']))
    else:
      self.turn_on(self.args['off_scene'])
      self.log('turning on {}'.format(self.args['off_scene']))

  def sunrise_cb(self, kwargs):
    if 'enable_switch' in self.args:
      if self.get_state(self.args['enable_switch']) == "off":
        self.log("not running {} due to {} being off".format(self.args['off_scene'], self.args['enable_switch']))
        return
    self.turn_on(self.args["off_scene"])
    self.log('turning on {}'.format(self.args['off_scene']))

  def sunset_cb(self, kwargs):
    if 'enable_switch' in self.args:
      if self.get_state(self.args['enable_switch']) == "off":
        self.log("not running {} due to {} being off".format(self.args['off_scene'], self.args['enable_switch']))
        return
    self.turn_on(self.args["on_scene"])
    self.log('turning on {}'.format(self.args['on_scene']))
