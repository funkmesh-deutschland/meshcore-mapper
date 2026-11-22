# Funkmesh Mapper

Web-App (PWA) von **Funkmesh Deutschland e.V.** zum Erfassen, **wo man welchen MeshCore-Repeater wie
gut empfängt**. Gedacht fürs Tablet oder Smartphone unterwegs. Die Daten dienen zur Kalibrierung des
[Funkmesh Repeater-Simulators](https://funkmesh.de).

**App öffnen:** https://funkmesh-deutschland.github.io/meshcore-mapper/

## Funktionen

* Verbindung zum MeshCore-Companion per **Bluetooth** (Web Bluetooth) oder **USB** (Web Serial).
* **Passive Erfassung** jedes empfangenen Pakets mit RSSI, SNR und GPS-Position samt Genauigkeit.
  Dazu der Repeater, der gesendet hat:
  * bei Flood-Paketen der letzte Pfad-Hash
  * bei Repeater-Adverts der volle Public Key
* **Aktiv-Test**: Trace über 1 Hop an ausgewählte Repeater in festem Takt, ohne Flooding. Das liefert
  Downlink-RSSI, Uplink-SNR und „kein Empfang“ bei Funklöchern.
* **Manuelle Erfassung** ohne Funkgerät.
* Messaufbau (zu Fuß / Fahrzeug / Außenantenne) und Antennenhöhe je Messpunkt.
* Alles bleibt **lokal auf dem Gerät** (IndexedDB) und ist offline nutzbar. Export als **CSV** (für
  den Simulator) oder JSON.

## Voraussetzungen

| Gerät | Bluetooth | GPS | als App installierbar |
|---|---|---|---|
| Android, Chrome/Edge | ✔ | ✔ | ✔ |
| Windows/Linux/macOS, Chrome/Edge | ✔ | ✔ | ✔ |
| iPad/iPhone, Safari | ✘ (nur manuell) | ✔ | ✔ |
| iPad/iPhone, Browser „Bluefy“ | ✔ | ✔ | – |

Bildschirm während der Aufnahme anlassen: Im Hintergrund stoppen Browser GPS und Bluetooth.

## CSV-Format

`time, lat, lon, gps_accuracy, gps_age_s, altitude, speed, rssi, snr, repeater, repeater_name,
direction, height, setup, kind, payload_type, route, hops, path, rssi_source, session`

* `repeater`: Pfad-Hash (1–3 Byte, hex) oder voller Public Key
* `rssi` leer = nicht empfangen
* `direction`: `down` (am Gerät gemessen) oder `up` (am Repeater, aus Trace-SNR geschätzt;
  `rssi_source=snr`)

## Entwicklung

Reine statische Seite ohne Build-Schritt. Lokal testen mit `python3 -m http.server`; `localhost` gilt
als sicherer Kontext. Deployment über GitHub Actions → GitHub Pages bei jedem Push auf `main`.

## Lizenz

MIT. Enthält meshcore.js (MIT) und Leaflet (BSD-2-Clause).
