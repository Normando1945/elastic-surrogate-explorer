# Surrogate Explorer

**Live page: https://normando1945.github.io/elastic-surrogate-explorer/**

An interactive walk through a neural surrogate of 2D elastic P-SV wave propagation under Quito, Ecuador: from the
globe down to the city's relief, the fault segment and the layered medium beneath it, the kinematic source, the
finite-difference solver, the network itself, and the receivers, where the network's accelerations and response
spectra sit next to the finite-difference simulation.

## What is in this repository

Only the static page, as it is served (HTML, JavaScript, stylesheets, images, and the data it draws). It is built from
the authors' private research repository and replaced as a whole on every update.

**The trained network is not published.** The page does not run the network: it reads the answers the network gave
for the six test media it offers, computed beforehand with the very graphs the authors' copy runs live. No model,
weights file or inference runtime is part of this repository.

## Authors

- Carlos A. Celi, author · [@Normando1945](https://github.com/Normando1945)
- Nicolás Mora Bowen · [@nmorabowen](https://github.com/nmorabowen)
- Patricio Palacios · [@ppalacios92](https://github.com/ppalacios92)
- José Abell, advisor · [@jaabell](https://github.com/jaabell)

Pontificia Universidad Católica del Ecuador · Universidad de los Andes (Chile), Facultad de Ingeniería y Ciencias
Aplicadas · Ladruño.

## Credits

Earth imagery: NASA Blue Marble and VIIRS Black Marble, through NASA GIBS. Libraries: three.js and d3, under their
own licences (see `vendor/`).

## Rights

© 2026 the authors. All rights reserved. The page may be viewed and linked freely; its content, data and images may
not be reused without the authors' permission.
