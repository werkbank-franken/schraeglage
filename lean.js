// Schräglagen-Schätzer: Gyroskop-Integration mit Stützung durch GPS-Tempo und Geraden-Erkennung.
// Reine Rechenlogik ohne DOM, damit sie sich getrennt testen lässt.
'use strict';
(function (root) {
  const G = 9.80665, D2R = Math.PI / 180, R2D = 180 / Math.PI;

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return scale(a, 1 / l); };

  // Achsen des Motorrads im Gerätesystem aus dem Schwerkraftvektor (aufrecht stehend).
  // u = oben, f = Fahrtrichtung, r = rechts. Rückseite des Handys zeigt nach vorn.
  function axesFromGravity(acc, swap) {
    const u = norm(acc);
    let cand = [0, 0, -1];                        // Rückseite des Displays
    if (Math.abs(dot(cand, u)) > 0.8) cand = [0, 1, 0]; // Handy liegt flach: Oberkante nach vorn
    let f = norm(sub(cand, scale(u, dot(cand, u))));
    if (swap) f = scale(f, -1);
    const r = cross(f, u);
    return { u, f, r };
  }

  // Standard für ein hochkant montiertes Handy mit Display zum Fahrer
  const DEFAULT_CAL = Object.assign(axesFromGravity([0, 9.81, 0], false), { bias: [0, 0, 0] });

  function createEstimator() {
    const s = { lean: 0, roll: 0, yaw: 0, ref: null, bias: [0, 0, 0] };

    // w: Drehrate im Gerätesystem [x,y,z] in °/s (Kalibrier-Bias schon abgezogen)
    // v: Tempo in m/s oder null, dt in s
    function step(cal, wIn, v, dt) {
      if (!(dt > 0)) return s.lean;
      dt = Math.min(dt, 0.1);
      const w = sub(wIn, s.bias);
      const roll = dot(w, cal.f);                     // + = neigt nach rechts
      let phi = s.lean + roll * dt;
      const c = Math.cos(phi * D2R), sn = Math.sin(phi * D2R);
      const up = sub(scale(cal.u, c), scale(cal.r, sn)); // Welt-Oben im Gerätesystem
      const yaw = dot(w, up);                         // + = Linkskurve

      let ref = null, tau = 0;
      if (v != null && v > 5) {
        // stationäre Kurvenfahrt: tan(phi) = v * omega / g
        ref = Math.atan(-v * yaw * D2R / G) * R2D;
        tau = Math.abs(roll) < 15 ? 1.2 : 3;          // beim Einlenken dem Gyro mehr trauen
      } else if (Math.abs(yaw) < 3 && Math.abs(roll) < 6) {
        ref = 0; tau = 4;                             // geradeaus: langsam auf 0 ziehen
      }
      // Auf Geraden und im Stand dreht sich das Motorrad im Mittel nicht:
      // was der Gyro dann noch misst, ist Sensordrift und wird nachgeführt.
      if (Math.abs(yaw) < 3 && Math.abs(roll) < 6 && Math.abs(phi) < 8) {
        const k = Math.min(1, dt / 15);
        for (let i = 0; i < 3; i++) s.bias[i] = Math.max(-3, Math.min(3, s.bias[i] + w[i] * k));
      }
      if (ref != null) phi += (ref - phi) * Math.min(1, dt / tau);
      phi = Math.max(-75, Math.min(75, phi));
      s.lean = phi; s.roll = roll; s.yaw = yaw; s.ref = ref;
      return phi;
    }
    function reset() { s.lean = 0; s.roll = 0; s.yaw = 0; s.ref = null; s.bias = [0, 0, 0]; }
    return { step, reset, state: s };
  }

  // Erzeugt passende Sensorwerte für eine gegebene Schräglage (für Demo und Test)
  function synth(cal, phi, phiRate, v) {
    const yaw = v > 0.5 ? -G * Math.tan(phi * D2R) / v * R2D : 0;
    const c = Math.cos(phi * D2R), sn = Math.sin(phi * D2R);
    const up = sub(scale(cal.u, c), scale(cal.r, sn));
    const w = [0, 1, 2].map(i => cal.f[i] * phiRate + up[i] * yaw);
    const g = Math.hypot(1, Math.tan(phi * D2R)) * G; // scheinbare Last entlang der Hochachse
    const acc = scale(cal.u, g);
    return { w, acc, yaw };
  }

  root.Lean = { createEstimator, axesFromGravity, DEFAULT_CAL, synth, dot, G };
})(typeof window !== 'undefined' ? window : globalThis);
