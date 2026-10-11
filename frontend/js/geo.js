/* Small helpers shared by the pages. Works in the browser (window.KoodaGeo)
   and in Node (module.exports) so the logic can be unit-tested. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.KoodaGeo = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- ward lookup (point in polygon) ---------- */

  // GeoJSON coordinates are [lng, lat]; x = lng, y = lat.
  function ringContains(ring, lng, lat) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) &&
          lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // rings[0] is the outer boundary, the rest are holes.
  function polygonContains(rings, lng, lat) {
    if (!rings.length || !ringContains(rings[0], lng, lat)) return false;
    for (var h = 1; h < rings.length; h++) {
      if (ringContains(rings[h], lng, lat)) return false;
    }
    return true;
  }

  function polygonsOf(geometry) {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return [geometry.coordinates];
    if (geometry.type === "MultiPolygon") return geometry.coordinates;
    return [];
  }

  function bboxOf(polygons) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    polygons.forEach(function (rings) {
      rings[0].forEach(function (pt) {
        if (pt[0] < b[0]) b[0] = pt[0];
        if (pt[1] < b[1]) b[1] = pt[1];
        if (pt[0] > b[2]) b[2] = pt[0];
        if (pt[1] > b[3]) b[3] = pt[1];
      });
    });
    return b;
  }

  function buildWardIndex(featureCollection) {
    var features = (featureCollection && featureCollection.features) || [];
    return features.map(function (feature) {
      var polygons = polygonsOf(feature.geometry);
      return { feature: feature, polygons: polygons, bbox: polygons.length ? bboxOf(polygons) : null };
    }).filter(function (entry) { return entry.bbox; });
  }

  function findWard(index, lat, lng) {
    for (var i = 0; i < index.length; i++) {
      var e = index[i], b = e.bbox;
      if (lng < b[0] || lat < b[1] || lng > b[2] || lat > b[3]) continue;
      for (var p = 0; p < e.polygons.length; p++) {
        if (polygonContains(e.polygons[p], lng, lat)) return e.feature;
      }
    }
    return null;
  }

  // Ward files name their fields differently, so match loosely.
  function wardLabel(properties) {
    var props = properties || {};
    var nameKeys = ["wardname", "name", "wname"];
    var numberKeys = ["wardno", "wardnumber", "wardnum", "wno", "ward"];
    var byKey = {};
    Object.keys(props).forEach(function (k) {
      byKey[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = props[k];
    });
    function pick(keys) {
      for (var i = 0; i < keys.length; i++) {
        var v = byKey[keys[i]];
        if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
      }
      return null;
    }
    var name = pick(nameKeys), number = pick(numberKeys);
    if (name && number && name !== number) return "Ward " + number + " \u00b7 " + name;
    if (name) return name;
    if (number) return "Ward " + number;
    var keys = Object.keys(props);
    for (var i = 0; i < keys.length; i++) {
      if (typeof props[keys[i]] === "string" && props[keys[i]].trim()) return props[keys[i]].trim();
    }
    return "Unnamed area (no ward name in the boundary file)";
  }

  /* ---------- display helpers ---------- */

  function formatDuration(days) {
    if (!(days >= 0)) return "unknown";
    var totalHours = Math.round(days * 24);
    if (totalHours < 1) return "less than 1 hour";
    if (totalHours < 24) return totalHours + (totalHours === 1 ? " hour" : " hours");
    var d = Math.floor(totalHours / 24), h = totalHours % 24;
    return d + (d === 1 ? " day" : " days") + (h ? " " + h + " h" : "");
  }

  function formatDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown";
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  }

  // Green under 3 days, amber under 14, red after that.
  function ageColor(days) {
    if (days < 3) return "#2e9e4f";
    if (days < 14) return "#f0a202";
    return "#d62828";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  return {
    buildWardIndex: buildWardIndex,
    findWard: findWard,
    wardLabel: wardLabel,
    formatDuration: formatDuration,
    formatDateTime: formatDateTime,
    ageColor: ageColor,
    escapeHtml: escapeHtml
  };
});
