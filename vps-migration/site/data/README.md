# Demo road geometry

Four public sample driving routes fetched on 5 October 2026 from the OSRM demonstration route service, using OpenStreetMap data. These are example terminal-to-address routes, not customer locations or truck GPS traces. Geometry is stored locally so repeated simulation does not call the routing service. Road clearance, weight limits, roadworks, and delivery access have not been checked.

- hcm.json: Cat Lai area to Thao Dien area, 12.9 km.
- hanoi.json: Hai Phong port area to Hanoi, 119.5 km.
- danang.json: Tien Sa port area to central Da Nang, 10.0 km.
- vancouver.json: Vancouver terminal area to a sample city address, 5.2 km.

OSRM documentation: https://project-osrm.org/docs/v5.24.0/api/
Source endpoint: https://router.project-osrm.org/route/v1/driving/ with the coordinates in each response, overview=full, geometries=geojson, steps=true.
Map data: © OpenStreetMap contributors, https://www.openstreetmap.org/copyright (ODbL).
Map tiles: https://tile.openstreetmap.de/ ; usage: https://openstreetmap.de/germanstyle/ .
Leaflet: https://leafletjs.com/ ; license in ../vendor/leaflet-LICENSE.txt.
