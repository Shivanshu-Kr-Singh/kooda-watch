(function () {
  "use strict";

  var G = window.KoodaGeo;
  var KEY_STORE = "kooda-officer-key";
  var DELHI_CENTER = [28.6139, 77.2090];
  // Shown in the legend so nobody mistakes demo boundaries for the official ones.
  // Update (or set to "") when you swap in a different frontend/data/wards.geojson.
  var WARD_SOURCE_NOTE = "Ward boundaries: 2017 delimitation (demo)";

  var $ = function (id) { return document.getElementById(id); };
  var loginEl = $("login"), loginForm = $("login-form"), keyInput = $("key-input");
  var loginError = $("login-error"), banner = $("banner");

  var officerKey = sessionStorage.getItem(KEY_STORE) || "";
  var wardIndex = [];
  var firstLoad = true;
  var heatLayer = null;
  var spotsLayer = L.layerGroup();
  var wardsLayer = null;

  // Ward colouring: which number paints the wards, and the totals behind it.
  var wardLayers = [];             // [{ feature, layer }] for every drawn ward
  var wardTotals = new Map();      // feature -> { reports, hotspots, longestDays }
  var dataLoaded = false;
  var colourMode = "off";          // off | reports | hotspots | longest
  var breaks = null;

  var METRICS = {
    reports:  { name: "Reports",      value: function (s) { return s.reports; },     show: function (v) { return String(Math.round(v)); } },
    hotspots: { name: "Hotspots",     value: function (s) { return s.hotspots; },    show: function (v) { return String(Math.round(v)); } },
    longest:  { name: "Longest open", value: function (s) { return s.longestDays; },  show: function (v) { return G.formatDuration(v); } }
  };

  /* ---------- map ---------- */

  var map = L.map("map", { zoomControl: true }).setView(DELHI_CENTER, 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors"
  }).addTo(map);

  // Stacking order: heat (overlay pane, 400) < wards (420) < hotspots (450).
  map.createPane("wards").style.zIndex = 420;
  map.createPane("spots").style.zIndex = 450;
  spotsLayer.addTo(map);

  var wardLegendEl = null;
  var legend = L.control({ position: "bottomright" });
  legend.onAdd = function () {
    var div = L.DomUtil.create("div", "legend");
    div.innerHTML =
      "<b>Open for</b><br>" +
      "<i style='background:" + G.ageColor(0) + "'></i>under 3 days<br>" +
      "<i style='background:" + G.ageColor(5) + "'></i>3 to 14 days<br>" +
      "<i style='background:" + G.ageColor(20) + "'></i>over 14 days";
    wardLegendEl = document.createElement("div");
    wardLegendEl.className = "ward-legend";
    div.appendChild(wardLegendEl);
    if (WARD_SOURCE_NOTE) {
      var note = document.createElement("div");
      note.className = "fine";
      note.textContent = WARD_SOURCE_NOTE;
      div.appendChild(note);
    }
    return div;
  };
  legend.addTo(map);

  function setBanner(text) {
    if (text) { banner.textContent = text; banner.classList.remove("hidden"); }
    else { banner.classList.add("hidden"); }
  }

  /* ---------- ward boundaries ---------- */

  function loadWards() {
    return fetch("data/wards.geojson", { cache: "no-cache" }).then(function (res) {
      if (!res.ok) throw new Error("missing");
      return res.json();
    }).then(function (geojson) {
      wardIndex = G.buildWardIndex(geojson);
      if (!wardIndex.length) throw new Error("empty");
      wardLayers = [];
      wardsLayer = L.geoJSON(geojson, {
        pane: "wards",
        style: wardStyle,
        onEachFeature: function (feature, layer) {
          wardLayers.push({ feature: feature, layer: layer });
          layer.bindTooltip(wardTooltip(feature), { sticky: true });
          layer.on("mouseover", function () { layer.setStyle({ weight: 2.5, color: "#111827" }); });
          layer.on("mouseout", function () { layer.setStyle(wardStyle(feature)); });
        }
      });
      if ($("layer-wards").checked) wardsLayer.addTo(map);
    }).catch(function () {
      $("layer-wards").checked = false;
      $("layer-wards").disabled = true;
      $("ward-colour").disabled = true;
      setBanner("Ward boundaries are not loaded: add the file frontend/data/wards.geojson (see the README). " +
                "The heatmap works without it, but ward names will not be shown.");
    });
  }

  /* ---------- ward colouring ---------- */

  var PLAIN_WARD = { color: "#2f5d8a", weight: 1, fillColor: "#2f5d8a", fillOpacity: 0.04 };

  function metricValue(feature) {
    var totals = wardTotals.get(feature);
    return totals ? METRICS[colourMode].value(totals) : 0;
  }

  function wardStyle(feature) {
    if (colourMode === "off") return PLAIN_WARD;
    var cls = G.classIndex(metricValue(feature), breaks);
    if (cls === 0) return PLAIN_WARD;     // nothing reported: leave it uncoloured
    return { color: "#6b7280", weight: 0.8, fillColor: G.HEAT_COLORS[cls], fillOpacity: 0.62 };
  }

  function wardTooltip(feature) {
    var head = "<b>" + G.escapeHtml(G.wardLabel(feature.properties)) + "</b>";
    if (!dataLoaded) return head;
    var t = wardTotals.get(feature);
    if (!t) return head + "<br>No reports";
    return head + "<br>" + t.reports + (t.reports === 1 ? " report" : " reports") + " &middot; " +
           t.hotspots + (t.hotspots === 1 ? " hotspot" : " hotspots") +
           "<br>longest open " + G.escapeHtml(G.formatDuration(t.longestDays));
  }

  function updateWardLegend() {
    if (!wardLegendEl) return;
    if (colourMode === "off" || !breaks) {
      wardLegendEl.innerHTML = colourMode === "off" ? "" :
        "<b>Wards</b><div class='fine'>Nothing reported yet.</div>";
      return;
    }
    var m = METRICS[colourMode];
    var rows = [];
    function row(cls, text) {
      return "<i class='sq' style='background:" + G.HEAT_COLORS[cls] + "'></i>" + G.escapeHtml(text) + "<br>";
    }
    // Highest first, and skip a class if no ward falls in it.
    if (breaks.max > breaks.mid) rows.push(row(3, "over " + m.show(breaks.mid)));
    if (breaks.mid > breaks.low) rows.push(row(2, "over " + m.show(breaks.low) + " to " + m.show(breaks.mid)));
    rows.push(row(1, "up to " + m.show(breaks.low)));
    wardLegendEl.innerHTML = "<b>Wards: " + G.escapeHtml(m.name.toLowerCase()) + "</b><br>" + rows.join("") +
      "<div class='fine'>Uncoloured = no reports. That does not mean the ward is clean: people may simply not have reported.</div>";
  }

  // Recompute class limits and repaint every ward (also refreshes the tooltips).
  function repaintWards() {
    breaks = null;
    if (colourMode !== "off") {
      breaks = G.classBreaks(wardLayers.map(function (w) { return metricValue(w.feature); }));
    }
    wardLayers.forEach(function (w) {
      w.layer.setStyle(wardStyle(w.feature));
      w.layer.setTooltipContent(wardTooltip(w.feature));
    });
    updateWardLegend();
  }

  /* ---------- hotspots ---------- */

  function safeUrl(url) {
    return typeof url === "string" && /^(https:\/\/|http:\/\/|\/)/.test(url) ? url : null;
  }

  function popupHtml(h) {
    var ward = G.findWard(wardIndex, h.lat, h.lng);
    var wardText = ward ? G.wardLabel(ward.properties)
                        : (wardIndex.length ? "Outside the ward boundaries" : "Ward not available");
    var photos = (h.images || []).map(safeUrl).filter(Boolean).map(function (u) {
      return "<a href='" + G.escapeHtml(u) + "' target='_blank' rel='noopener'>" +
             "<img src='" + G.escapeHtml(u) + "' alt='Report photo' loading='lazy'></a>";
    }).join("");
    return "<div class='popup'>" +
      "<h3>Garbage hotspot</h3>" +
      "<div class='ward'>" + G.escapeHtml(wardText) + "</div>" +
      "<div class='big'>Open for " + G.escapeHtml(G.formatDuration(h.daysOpen)) + "</div>" +
      "<table>" +
        "<tr><td>First reported</td><td>" + G.escapeHtml(G.formatDateTime(h.firstReportedAt)) + "</td></tr>" +
        "<tr><td>Latest report</td><td>" + G.escapeHtml(G.formatDateTime(h.lastReportedAt)) + "</td></tr>" +
        "<tr><td>First to latest</td><td>" + G.escapeHtml(G.formatDuration(h.reportedSpanDays)) + "</td></tr>" +
        "<tr><td>Reports</td><td>" + G.escapeHtml(h.reportCount) + "</td></tr>" +
      "</table>" +
      (photos ? "<div class='photos'>" + photos + "</div>" : "") +
      (h.demo ? "<div class='demo'>Demo data, not a real report.</div>" : "") +
      "</div>";
  }

  function render(data) {
    var spots = data.hotspots || [];
    $("stat-reports").textContent = data.totalReports;
    $("stat-hotspots").textContent = spots.length;
    $("stat-oldest").textContent = spots.length ? G.formatDuration(spots[0].daysOpen) : "-";
    $("updated").textContent = "updated " +
      new Date(data.generatedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

    wardTotals = G.wardStats(wardIndex, spots).byWard;
    dataLoaded = true;
    repaintWards();

    spotsLayer.clearLayers();
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

    var maxCount = spots.reduce(function (m, h) { return Math.max(m, h.reportCount); }, 1);
    var heatPoints = spots.map(function (h) {
      return [h.lat, h.lng, Math.min(1, 0.3 + 0.7 * (h.reportCount / maxCount))];
    });
    heatLayer = L.heatLayer(heatPoints, {
      radius: 30, blur: 24, maxZoom: 15, minOpacity: 0.35,
      gradient: { 0.2: "#ffeda0", 0.5: "#feb24c", 0.75: "#f03b20", 1.0: "#800026" }
    });
    if ($("layer-heat").checked) heatLayer.addTo(map);

    spots.forEach(function (h) {
      L.circleMarker([h.lat, h.lng], {
        pane: "spots",
        radius: Math.min(16, 7 + Math.sqrt(h.reportCount) * 2),
        color: "#ffffff", weight: 2,
        fillColor: G.ageColor(h.daysOpen), fillOpacity: 0.92
      }).bindPopup(popupHtml(h), { maxWidth: 300 }).addTo(spotsLayer);
    });

    if (firstLoad && spots.length) {
      var bounds = L.latLngBounds(spots.map(function (h) { return [h.lat, h.lng]; }));
      map.fitBounds(bounds.pad(0.15), { maxZoom: 14 });
    }
    firstLoad = false;
  }

  function load() {
    return fetch("/api/hotspots", { headers: { "x-officer-key": officerKey } }).then(function (res) {
      if (res.status === 401) { var e = new Error("auth"); e.auth = true; throw e; }
      if (!res.ok) throw new Error("Could not load reports (error " + res.status + ").");
      return res.json();
    }).then(function (data) {
      loginEl.classList.add("hidden");
      sessionStorage.setItem(KEY_STORE, officerKey);
      render(data);
    }).catch(function (err) {
      if (err.auth) {
        sessionStorage.removeItem(KEY_STORE);
        officerKey = "";
        loginEl.classList.remove("hidden");
        loginError.textContent = "That passcode was not accepted.";
        loginError.classList.remove("hidden");
        return;
      }
      setBanner(err.message === "Failed to fetch"
        ? "Could not reach the server. Check your connection and press Refresh."
        : err.message);
    });
  }

  /* ---------- controls ---------- */

  loginForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    officerKey = keyInput.value.trim();
    loginError.classList.add("hidden");
    keyInput.value = "";
    load();
  });

  $("refresh-btn").addEventListener("click", load);

  $("layer-heat").addEventListener("change", function (ev) {
    if (!heatLayer) return;
    if (ev.target.checked) heatLayer.addTo(map); else map.removeLayer(heatLayer);
  });
  $("layer-spots").addEventListener("change", function (ev) {
    if (ev.target.checked) spotsLayer.addTo(map); else map.removeLayer(spotsLayer);
  });
  $("layer-wards").addEventListener("change", function (ev) {
    if (!wardsLayer) return;
    if (ev.target.checked) wardsLayer.addTo(map); else map.removeLayer(wardsLayer);
  });
  $("ward-colour").addEventListener("change", function (ev) {
    colourMode = ev.target.value;
    // Colouring lives on the ward layer, so make sure that layer is showing.
    if (colourMode !== "off" && wardsLayer && !$("layer-wards").checked) {
      $("layer-wards").checked = true;
      wardsLayer.addTo(map);
    }
    repaintWards();
  });

  /* ---------- start ---------- */

  // Wards first, so the popups can name the ward as soon as hotspots arrive.
  loadWards().then(function () {
    if (officerKey) load(); else loginEl.classList.remove("hidden");
  });
})();
