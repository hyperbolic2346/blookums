"""
RoomOccupancy - Direction-of-travel occupancy detection for Home Assistant.

Uses sensor zones (exterior/boundary/interior) to determine whether someone
is entering or leaving a room. Writes occupancy state to an HA input_select
entity so that HA automations can react (lights, sound, fans, etc.).

Reusable across rooms — configure sensors, zones, and timings in apps.yaml.
"""

import appdaemon.plugins.hass.hassapi as hass
from collections import deque
from datetime import datetime, timedelta


STATE_EMPTY = "Empty"
STATE_OCCUPIED = "Occupied"
STATE_PENDING_EXIT = "Pending Exit"

ZONE_EXTERIOR = 0
ZONE_BOUNDARY = 1
ZONE_INTERIOR = 2

ZONE_MAP = {"exterior": ZONE_EXTERIOR, "boundary": ZONE_BOUNDARY, "interior": ZONE_INTERIOR}


class RoomOccupancy(hass.Hass):

    def initialize(self):
        self.sensor_hits = deque(maxlen=50)
        self.occupancy = STATE_EMPTY
        self.pending_exit_handle = None
        self.safety_handle = None

        # Config
        self.sensors = self.args.get("sensors", [])
        self.direction_window = self.args.get("direction_window", 10)
        self.exit_grace_period = self.args.get("exit_grace_period", 90)
        self.safety_timeout = self.args.get("safety_timeout", 1800)
        self.occupancy_entity = self.args["occupancy_entity"]

        # Build sensor zone lookup
        self.sensor_zones = {}
        for sensor in self.sensors:
            entity = sensor["entity"]
            zone = ZONE_MAP[sensor["zone"]]
            self.sensor_zones[entity] = zone
            self.listen_state(self._on_motion, entity, new="on")

        # Sync state from HA entity on startup (in case of restart mid-occupancy)
        current = self.get_state(self.occupancy_entity)
        if current in (STATE_OCCUPIED, STATE_PENDING_EXIT):
            self.occupancy = STATE_OCCUPIED
            self._reset_safety_timer()
            self.log(f"Restored state {current} from {self.occupancy_entity}")

        self.log(
            f"Initialized: {len(self.sensors)} sensors, "
            f"state={self.occupancy}, entity={self.occupancy_entity}"
        )

    # ── Sensor callbacks ──────────────────────────────────────────────

    def _on_motion(self, entity, attribute, old, new, kwargs):
        now = datetime.now()
        zone = self.sensor_zones[entity]
        self.sensor_hits.append((now, entity, zone))

        direction = self._detect_direction(now, zone)
        self.log(f"Motion: {entity} zone={zone} dir={direction} state={self.occupancy}")

        if self.occupancy == STATE_EMPTY:
            self._handle_empty(zone, direction)
        elif self.occupancy == STATE_OCCUPIED:
            self._handle_occupied(zone, direction)
        elif self.occupancy == STATE_PENDING_EXIT:
            self._handle_pending_exit(zone, direction)

    def _handle_empty(self, zone, direction):
        if zone == ZONE_EXTERIOR and direction != "entry":
            return
        self._set_occupancy(STATE_OCCUPIED)
        self._reset_safety_timer()

    def _handle_occupied(self, zone, direction):
        self._reset_safety_timer()
        if zone == ZONE_BOUNDARY:
            # Door sensor fired while occupied — someone is at the door, possibly leaving.
            # This is the ONLY signal that can start an exit. Exterior sensors are ignored
            # while occupied (other people walking by in the hall).
            self._set_occupancy(STATE_PENDING_EXIT)
            self.pending_exit_handle = self.run_in(
                self._on_exit_confirmed, self.exit_grace_period
            )

    def _handle_pending_exit(self, zone, direction):
        if zone == ZONE_INTERIOR:
            # Interior sensor — they're still in the room, cancel exit
            self._cancel(self.pending_exit_handle)
            self.pending_exit_handle = None
            self._set_occupancy(STATE_OCCUPIED)
            self._reset_safety_timer()
        elif zone == ZONE_BOUNDARY:
            # Door sensor again — could be lingering at the door, restart grace period
            self._cancel(self.pending_exit_handle)
            self.pending_exit_handle = self.run_in(
                self._on_exit_confirmed, self.exit_grace_period
            )
        # Exterior sensor ignored — someone else in the hall

    # ── Direction detection ───────────────────────────────────────────

    def _detect_direction(self, now, current_zone):
        window = timedelta(seconds=self.direction_window)
        recent = [
            (t, e, z)
            for t, e, z in self.sensor_hits
            if now - t <= window and z != current_zone
        ]
        if not recent:
            return "unknown"

        prev_zone = recent[-1][2]
        if prev_zone < current_zone:
            return "entry"
        elif prev_zone > current_zone:
            return "exit"
        return "unknown"

    # ── Timer callbacks ───────────────────────────────────────────────

    def _on_exit_confirmed(self, kwargs):
        self.pending_exit_handle = None
        self._set_occupancy(STATE_EMPTY)

    def _on_safety_timeout(self, kwargs):
        self.safety_handle = None
        self.log(f"Safety timeout after {self.safety_timeout}s - forcing empty")
        self._cancel(self.pending_exit_handle)
        self.pending_exit_handle = None
        self._set_occupancy(STATE_EMPTY)

    def _reset_safety_timer(self):
        self._cancel(self.safety_handle)
        self.safety_handle = self.run_in(self._on_safety_timeout, self.safety_timeout)

    # ── State management ──────────────────────────────────────────────

    def _set_occupancy(self, new_state):
        old = self.occupancy
        self.occupancy = new_state
        self.log(f"Occupancy: {old} → {new_state}")

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
