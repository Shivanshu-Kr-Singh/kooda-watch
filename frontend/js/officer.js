(function () {
  "use strict";

  var G = window.KoodaGeo;
  var KEY_STORE = "kooda-officer-key";
  var DELHI_CENTER = [28.6139, 77.2090];

  var $ = function (id) { return document.getElementById(id); };
  var loginEl = $("login"), loginForm = $("login-form"), keyInput = $("key-input");
  var loginError = $("login-error"), banner = $("banner");

  var officerKey = sessionStorage.getItem(KEY_STORE) || "";
  var wardIndex = [];
  var firstLoad = true;
  var heatLayer = null;
  var spotsLayer = L.layerGroup();
  var wardsLayer = null;

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

  var legend = L.control({ position: "bottomright" });
  legend.onAdd = function () {
    var div = L.DomUtil.create("div", "legend");
    div.innerHTML =
      "<b>Open for</b><br>" +
      "<i style='background:" + G.ageColor(0) + "'></i>under 3 days<br>" +
      "<i style='background:" + G.ageColor(5) + "'></i>3 to 14 days<br>" +
      "<i style='background:" + G.ageColor(20) + "'></i>over 14 days";
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
      wardsLayer = L.geoJSON(geojson, {
        pane: "wards",
        style: { color: "#2f5d8a", weight: 1, fillColor: "#2f5d8a", fillOpacity: 0.04 },
        onEachFeature: function (feature, layer) {
          layer.bindTooltip(G.escapeHtml(G.wardLabel(feature.properties)), { sticky: true });
          layer.on("mouseover", function () { layer.setStyle({ weight: 2, fillOpacity: 0.12 }); });
          layer.on("mouseout", function () { wardsLayer.resetStyle(layer); });
        }
      });
      if ($("layer-wards").checked) wardsLayer.addTo(map);
    }).catch(function () {
      $("layer-wards").checked = false;
      $("layer-wards").disabled = true;
      setBanner("Ward boundaries are not loaded: add the file frontend/data/wards.geojson (see the README). " +
                "The heatmap works without it, but ward names will not be shown.");
    });
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

  /* ---------- start ---------- */

  // Wards first, so the popups can name the ward as soon as hotspots arrive.
  loadWards().then(function () {
    if (officerKey) load(); else loginEl.classList.remove("hidden");
  });
})();
