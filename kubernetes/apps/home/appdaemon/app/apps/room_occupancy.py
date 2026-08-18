"""
RoomOccupancy - Wasp-in-a-box occupancy detection for Home Assistant.

Simple two-sensor model:
  - Interior sensor fires → Occupied (something went in the box)
  - Boundary sensor fires → Pending Exit (something crossed the door,
    could be entering or leaving — we don't know)
  - If Pending Exit holds long enough with no interior activity → Empty

Exterior sensors are ignored (too noisy / unreliable).

Reusable across rooms — configure sensors and timings in apps.yaml.
"""

import appdaemon.plugins.hass.hassapi as hass
from datetime import datetime


STATE_EMPTY = "Empty"
STATE_OCCUPIED = "Occupied"
STATE_PENDING_EXIT = "Pending Exit"

ZONE_EXTERIOR = 0
ZONE_BOUNDARY = 1
ZONE_INTERIOR = 2

ZONE_MAP = {"exterior": ZONE_EXTERIOR, "boundary": ZONE_BOUNDARY, "interior": ZONE_INTERIOR}


class RoomOccupancy(hass.Hass):

    def initialize(self):
        self.occupancy = STATE_EMPTY
        self.pending_exit_handle = None
        self.safety_handle = None
        self.entry_confirm_handle = None

        # Config
        self.sensors = self.args.get("sensors", [])
        self.exit_grace_period = self.args.get("exit_grace_period", 120)
        self.safety_timeout = self.args.get("safety_timeout", 1800)
        # A boundary trip alone does not prove anybody came in. Without interior
        # confirmation within this long, treat it as someone walking past the
        # door. Before this existed the only way back from a phantom Occupied
        # was safety_timeout - on 2026-08-17 a single trip at 18:20:47 held the
        # room Occupied for the full 30 minutes with both sensors reading off,
        # which also blocks BathFan's post-exit tail from ever arming.
        # Deliberately generous: someone quietly in the shower may not trip the
        # interior sensor for a while, and calling the room empty while they are
        # in it is the worse error.
        self.entry_confirm = self.args.get("entry_confirm_seconds", 600)
        self.occupancy_entity = self.args["occupancy_entity"]

        # Build sensor zone lookup and subscribe
        self.sensor_zones = {}
        for sensor in self.sensors:
            entity = sensor["entity"]
            zone = ZONE_MAP[sensor["zone"]]
            self.sensor_zones[entity] = zone
            if zone == ZONE_EXTERIOR:
                self.log(f"Skipping exterior sensor {entity} (ignored)")
                continue
            self.listen_state(self._on_motion, entity, new="on")

        # Sync state from HA entity on startup. AppDaemon and HA both restart
        # (deploys, reboots), and the room does not empty just because we did.
        current = self.get_state(self.occupancy_entity)
        if current == STATE_OCCUPIED:
            self.occupancy = STATE_OCCUPIED
            self._reset_safety_timer()
            self.log(f"Restored {current} from {self.occupancy_entity}")
        elif current == STATE_PENDING_EXIT:
            # Keep it pending and re-arm the countdown. Collapsing this to
            # Occupied (the old behaviour) threw away the only timer that
            # reaches Empty, so a restart mid-exit stranded the room Occupied
            # until another door trip or the safety timeout.
            self.occupancy = STATE_PENDING_EXIT
            self._reset_safety_timer()
            self.pending_exit_handle = self.run_in(
                self._on_exit_confirmed, self.exit_grace_period
            )
            self.log(f"Restored {current} from {self.occupancy_entity}, exit timer re-armed")

        # If HA restarts under us its input_select may come back at the default
        # option while our own state is still correct. Re-assert on reconnect.
        self.listen_event(self._on_ha_start, "homeassistant_start")
        self.listen_event(self._on_ha_start, "plugin_restarted")

        self.log(
            f"Initialized: sensors={[s['entity'] for s in self.sensors if ZONE_MAP[s['zone']] != ZONE_EXTERIOR]}, "
            f"state={self.occupancy}, entity={self.occupancy_entity}"
        )

    # ── Sensor callback ──────────────────────────────────────────────

    def _on_motion(self, entity, attribute, old, new, kwargs):
        zone = self.sensor_zones[entity]
        self.log(f"Motion: {entity} zone={zone} state={self.occupancy}")

        if zone == ZONE_INTERIOR:
            self._on_interior()
        elif zone == ZONE_BOUNDARY:
            self._on_boundary()

    def _on_interior(self):
        """Interior sensor fired — someone is definitely in the room."""
        self._cancel(self.pending_exit_handle)
        self.pending_exit_handle = None
        # Entry is now confirmed by real interior activity.
        self._cancel(self.entry_confirm_handle)
        self.entry_confirm_handle = None
        if self.occupancy != STATE_OCCUPIED:
            self._set_occupancy(STATE_OCCUPIED)
        self._reset_safety_timer()

    def _on_boundary(self):
        """Boundary (door) sensor fired — someone crossed the threshold.
        Could be entering or leaving. If we were occupied, start the
        exit countdown. If empty, assume entry."""
        if self.occupancy == STATE_EMPTY:
            # Door sensor while empty — probably someone walking in, but it
            # could equally be someone passing the doorway. Believe it for now
            # and start a confirmation timer; interior motion cancels it.
            self._set_occupancy(STATE_OCCUPIED)
            self._reset_safety_timer()
            self._cancel(self.entry_confirm_handle)
            self.entry_confirm_handle = self.run_in(
                self._on_entry_unconfirmed, self.entry_confirm
            )
        elif self.occupancy == STATE_OCCUPIED:
            # Door sensor while occupied — might be leaving
            self._set_occupancy(STATE_PENDING_EXIT)
            self._cancel(self.pending_exit_handle)
            self.pending_exit_handle = self.run_in(
                self._on_exit_confirmed, self.exit_grace_period
            )
        elif self.occupancy == STATE_PENDING_EXIT:
            # Door sensor again while pending — could be coming back
            # Reset the exit timer to give more time
            self._cancel(self.pending_exit_handle)
            self.pending_exit_handle = self.run_in(
                self._on_exit_confirmed, self.exit_grace_period
            )

    # ── Timer callbacks ───────────────────────────────────────────────

    def _on_exit_confirmed(self, kwargs):
        self.pending_exit_handle = None
        self._set_occupancy(STATE_EMPTY)

    def _on_entry_unconfirmed(self, kwargs):
        self.entry_confirm_handle = None
        if self.occupancy != STATE_OCCUPIED:
            return
        self.log(
            f"Boundary trip never confirmed by interior motion in "
            f"{self.entry_confirm}s — treating as a pass-by"
        )
        self._set_occupancy(STATE_EMPTY)

    def _on_ha_start(self, event_name, data, kwargs):
        """HA came back. Push our state onto the entity in case it reset."""
        current = self.get_state(self.occupancy_entity)
        if current != self.occupancy:
            self.log(f"HA restart: {self.occupancy_entity} is {current}, re-asserting {self.occupancy}")
            self._publish(self.occupancy)

    def _on_safety_timeout(self, kwargs):
        self.safety_handle = None
        self.log(f"Safety timeout after {self.safety_timeout}s — forcing empty")
        self._cancel(self.pending_exit_handle)
        self.pending_exit_handle = None
        self._cancel(self.entry_confirm_handle)
        self.entry_confirm_handle = None
        self._set_occupancy(STATE_EMPTY)

    def _reset_safety_timer(self):
        self._cancel(self.safety_handle)
        self.safety_handle = self.run_in(self._on_safety_timeout, self.safety_timeout)

    # ── State management ──────────────────────────────────────────────

    def _set_occupancy(self, new_state):
        old = self.occupancy
        self.occupancy = new_state
        self.log(f"Occupancy: {old} → {new_state}")
        self._publish(new_state)

    def _publish(self, new_state):
        try:
            self.call_service(
                "input_select/select_option",
                entity_id=self.occupancy_entity,
                option=new_state,
            )
        except Exception as e:
            self.log(f"Failed to update {self.occupancy_entity}: {e}", level="WARNING")

    # ── Helpers ───────────────────────────────────────────────────────

    def _cancel(self, handle):
        if handle:
            try:
                self.cancel_timer(handle)
            except Exception:
                pass
