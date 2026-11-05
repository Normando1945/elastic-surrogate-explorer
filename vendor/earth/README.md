# Globe imagery (NASA, public domain)

Made by `python web/tools/export_earth.py` from NASA GIBS (Global Imagery Browse Services) WMS, in plate carrée
(EPSG:4326), the equirectangular layout three.js's sphere UVs expect:

| File | GIBS layer | Box (lon, lat) | Size |
|---|---|---|---|
| `day.jpg` | `BlueMarble_ShadedRelief_Bathymetry` | whole Earth | 4096 × 2048 |
| `night.jpg` | `VIIRS_Black_Marble` (2016) | whole Earth | 4096 × 2048 |
| `detail.jpg` | `BlueMarble_ShadedRelief_Bathymetry` | −84…−72, −6…6 (around Quito) | 2048 × 2048 |

NASA imagery is not copyrighted. Acknowledgement, as GIBS asks: "We acknowledge the use of imagery provided by
services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System
(ESDIS)." The credits chapter of the page says the same.
