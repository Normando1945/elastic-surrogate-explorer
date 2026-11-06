# Globe imagery (NASA, public domain)

Made by `python web/tools/export_earth.py` from NASA GIBS (Global Imagery Browse Services) WMS, in plate carrée
(EPSG:4326), the equirectangular layout three.js's sphere UVs expect:

| File | GIBS layer(s) | Box (lon, lat) | Size |
|---|---|---|---|
| `day.jpg` | `BlueMarble_NextGeneration` (no shading baked in: the page lights the relief) | whole Earth | 4096 × 2048 |
| `night.jpg` | `VIIRS_Black_Marble` (2016) | whole Earth | 4096 × 2048 |
| `detail.jpg` | `BlueMarble_NextGeneration` | −84…−72, −6…6 (around Quito) | 2048 × 2048 |
| `clouds.jpg` | `VIIRS_{SNPP,NOAA20,NOAA21}_CorrectedReflectance_TrueColor`, 2025-09-03, minus `BlueMarble_NextGeneration`: grey = cloud opacity | whole Earth | 4096 × 2048 |
| `relief.jpg` | R: `ASTER_GDEM_Color_Index` read back through its colour map, as sqrt(h / 8848 m); G: `OSM_Land_Water_Map` (land = 1) | whole Earth | 4096 × 2048 |
| `relief_detail.jpg` | the same | −84…−72, −6…6 | 2048 × 2048 |

NASA imagery is not copyrighted. Acknowledgement, as GIBS asks: "We acknowledge the use of imagery provided by
services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System
(ESDIS)." The credits chapter of the page says the same.
