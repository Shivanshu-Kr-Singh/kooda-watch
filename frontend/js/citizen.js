(function () {
  "use strict";

  var MAX_SIDE = 1280;        // longest photo side after shrinking, in pixels
  var JPEG_QUALITY = 0.72;
  var GPS_TIMEOUT_MS = 20000;
  var WEAK_GPS_METERS = 100;

  var $ = function (id) { return document.getElementById(id); };
  var photoInput = $("photo-input"), photoBtn = $("photo-btn"), preview = $("preview");
  var gpsBtn = $("gps-btn"), gpsNote = $("gps-note");
  var submitBtn = $("submit-btn"), result = $("result"), whenEl = $("when");

  var state = { image: null, capturedAt: null, position: null, busy: false };

  function show(el, kind, text) {
    el.className = "notice " + kind;
    el.textContent = text;
  }

  function refresh() {
    submitBtn.disabled = state.busy || !(state.image && state.position);
  }

  /* ---------- photo ---------- */

  photoBtn.addEventListener("click", function () { photoInput.click(); });

  photoInput.addEventListener("change", function () {
    var file = photoInput.files && photoInput.files[0];
    if (!file) return;
    shrink(file).then(function (dataUrl) {
      state.image = dataUrl.split(",")[1];
      state.capturedAt = new Date();
      preview.src = dataUrl;
      preview.classList.remove("hidden");
      photoBtn.textContent = "Retake photo";
      whenEl.textContent = state.capturedAt.toLocaleString("en-IN", {
        day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit"
      });
      result.className = "notice hidden";
      refresh();
      if (!state.position) getLocation();   // ask for GPS right after the photo
    }).catch(function () {
      show(result, "error", "That photo could not be read. Please try again.");
    });
  });

  // Shrink on the phone so uploads stay small on slow mobile data.
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      img.src = url;
    });
  }

  /* ---------- location ---------- */

  gpsBtn.addEventListener("click", getLocation);

  function getLocation() {
    if (!navigator.geolocation) {
      show(gpsNote, "error", "This browser cannot share a location.");
      return;
    }
    gpsBtn.disabled = true;
    gpsBtn.textContent = "Finding your location...";
    gpsNote.className = "notice hidden";

    navigator.geolocation.getCurrentPosition(function (pos) {
      state.position = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      };
      $("coords").textContent = state.position.lat.toFixed(5) + ", " + state.position.lng.toFixed(5);
      $("accuracy").textContent = "within " + Math.round(state.position.accuracy) + " m";
      $("location-facts").classList.remove("hidden");
      gpsBtn.disabled = false;
      gpsBtn.textContent = "Refresh my location";
      if (state.position.accuracy > WEAK_GPS_METERS) {
        show(gpsNote, "warn", "GPS is weak here. Step into the open and tap \"Refresh my location\" for a better fix.");
      }
      refresh();
    }, function (err) {
      gpsBtn.disabled = false;
      gpsBtn.textContent = "Use my current location";
      var message = err.code === 1
        ? "Location permission was denied. Allow location for this site in your browser settings, then try again."
        : "Could not find your location. Check that GPS is on and try again.";
      show(gpsNote, "error", message);
    }, { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 0 });
  }

  /* ---------- send ---------- */

  submitBtn.addEventListener("click", function () {
    if (!state.image || !state.position) return;
    state.busy = true;
    submitBtn.textContent = "Sending...";
    refresh();

    fetch("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image: state.image,
        lat: state.position.lat,
        lng: state.position.lng,
        accuracy: state.position.accuracy,
        capturedAt: state.capturedAt.toISOString()
      })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "Could not send the report.");
        return data;
      });
    }).then(function () {
      show(result, "ok", "Thank you! Your report has been sent to the municipal team.");
      state.image = null;
      state.capturedAt = null;
      preview.classList.add("hidden");
      photoInput.value = "";
      photoBtn.textContent = "Take another photo";
      whenEl.textContent = "Set when you take the photo";
    }).catch(function (err) {
      show(result, "error", err.message === "Failed to fetch"
        ? "No connection. Check your network and tap Send again."
        : err.message);
    }).then(function () {
      state.busy = false;
      submitBtn.textContent = "Send report";
      refresh();
    });
  });
})();
