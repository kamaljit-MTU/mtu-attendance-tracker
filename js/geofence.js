/* =========================================================
   geofence.js - HTML5 Geolocation wrapper + Haversine distance
   ========================================================= */

const Geofence = (() => {
  const EARTH_R = 6371000; // meters

  // Great-circle distance between two lat/lng points (meters)
  function distanceMeters(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_R * c;
  }

  function isInside(geo, point) {
    if (!geo || !point) return false;
    const d = distanceMeters(geo.lat, geo.lng, point.lat, point.lng);
    return { inside: d <= geo.radiusM, distanceM: d };
  }

  // Get current position with promise. Options: high accuracy, 10s timeout.
  function getCurrent(opts = {}) {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('Geolocation is not supported by this browser.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        }),
        (err) => reject(new Error(geolocationErrorMessage(err))),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0, ...opts }
      );
    });
  }

  function geolocationErrorMessage(err) {
    switch (err.code) {
      case 1: return 'Permission denied. Please allow location access to mark attendance.';
      case 2: return 'Position unavailable. Check your device location services.';
      case 3: return 'Location request timed out. Try again in an open area.';
      default: return err.message || 'Unknown geolocation error.';
    }
  }

  // Use IP-based fallback for demo (so app works without real GPS) - called only on user click
  async function getWithFallback() {
    try {
      return await getCurrent();
    } catch (e) {
      // Try a coarse IP geolocation as a last resort
      try {
        const r = await fetch('https://ipapi.co/json/');
        if (!r.ok) throw new Error('IP lookup failed');
        const data = await r.json();
        if (data && data.latitude && data.longitude) {
          return { lat: data.latitude, lng: data.longitude, accuracy: 5000, timestamp: Date.now(), approx: true };
        }
        throw new Error('IP geolocation incomplete');
      } catch (e2) {
        throw new Error(e.message + ' (and IP fallback failed)');
      }
    }
  }

  return { distanceMeters, isInside, getCurrent, getWithFallback };
})();
