/* =========================================================
   1. SETTINGS
========================================================= */

const COLORS = {
    trash: "#4b5563",
    recycling: "#2e86de",
    compost: "#7a4fb5"
};

const ROUTE_COLORS = [
    "#e63946",
    "#2a9d8f",
    "#457b9d",
    "#f4a261",
    "#9b5de5",
    "#f72585"
];

const LABELS = {
    trash: "Trash",
    recycling: "Recycling",
    compost: "Compost"
};

const LEVEL_COLOR = {
    ok: "#3aa76d",
    mid: "#f2a900",
    full: "#d64545",
    none: "#9aa3ad"
};

const DEFAULT_MPG = 3;
const MAX_ROUTES = 6;

/* =========================================================
   2. APPLICATION DATA
========================================================= */

let bins = [];
let telemetry = [];
let collections = [];
let events = [];
let stations = [];
let trucks = [];

let selectedDate = "";
let dispatches = [];

/* Route-selection state */
let routeMode = false;
let selectedRouteBins = new Set();

/* Saved routes are stored separately for each day. */
let routesByDay = {};

/*
   One normal-garbage-day baseline is stored per day.
   This prevents the baseline from being counted again
   every time the user creates another optimized route.
*/
let baselineByDay = {};
let baselineRoutesByDay = {};
// Remembers which bin was clicked from the sidebar.
let sidebarSelectedBinId = null;

/* Unique internal IDs for saved routes. */
let nextRouteId = 1;

/* Baseline map visibility. */
let baselineVisible = false;

/* =========================================================
   3. SMALL HTML HELPER
========================================================= */

const $ = id => document.getElementById(id);

/* =========================================================
   4. MAP SETUP
========================================================= */

const map = L.map("map").setView(
    [42.2766, -83.7382],
    14
);

L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
    }
).addTo(map);

/* Separate layers let us show/hide different things. */
const binLayer = L.layerGroup().addTo(map);
const truckLayer = L.layerGroup().addTo(map);
const stationLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const baselineLayer = L.layerGroup().addTo(map);

/* Lets the bin list find the correct map marker. */
const markers = new Map();

/* =========================================================
   5. GENERAL HELPERS
========================================================= */

/* Escape text before putting data inside HTML. */
function esc(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

/* Small message shown at the bottom/status area. */
function toast(message) {
    const status = $("status");
    if (!status) return;

    status.textContent = message;
    status.style.display = "block";

    clearTimeout(window.toastTimer);

    window.toastTimer = setTimeout(() => {
        status.style.display = "none";
    }, 3000);
}

/* Convert YYYY-MM-DD into a friendly date. */
function formatDate(date) {
    if (!date) return "No date";

    return new Date(`${date}T12:00:00`).toLocaleDateString(
        undefined,
        {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric"
        }
    );
}

/* Convert minutes into a readable ETA. */
function formatETA(minutes) {
    if (!Number.isFinite(minutes)) return "Unknown";
    if (minutes < 1) return "< 1 min";

    const rounded = Math.round(minutes);

    if (rounded < 60) {
        return `${rounded} min`;
    }

    const hours = Math.floor(rounded / 60);
    const mins = rounded % 60;

    return `${hours} hr ${mins} min`;
}

/* Haversine distance in miles. */
function distanceMiles(a, b) {
    const R = 3958.8;

    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;

    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) *
        Math.cos(lat2) *
        Math.sin(dLng / 2) ** 2;

    return 2 * R * Math.asin(Math.sqrt(h));
}

/* Convert different waste-stream names into one standard name. */
function normalizeType(value) {
    value = String(value || "").toLowerCase();

    if (["landfill", "trash", "garbage"].includes(value)) {
        return "trash";
    }

    if (["recycling", "recycle"].includes(value)) {
        return "recycling";
    }

    if (["compost", "organic"].includes(value)) {
        return "compost";
    }

    return "trash";
}

/* Turn a fill percentage into a CSS/status level. */
function levelOf(fill) {
    if (!Number.isFinite(fill)) return "none";
    if (fill >= 80) return "full";
    if (fill >= 50) return "mid";
    return "ok";
}

/* Get the waste types currently checked in the UI. */
function activeTypes() {
    return [
        ...document.querySelectorAll(
            "#controls input[data-type]:checked"
        )
    ].map(input => input.dataset.type);
}

/* =========================================================
   6. CSV PARSER
========================================================= */

/*
   Simple CSV parser that supports quoted cells and commas
   inside quoted values.
*/
function csvParse(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];

        if (c === '"' && quoted && next === '"') {
            cell += '"';
            i++;
        } else if (c === '"') {
            quoted = !quoted;
        } else if (c === "," && !quoted) {
            row.push(cell.trim());
            cell = "";
        } else if ((c === "\n" || c === "\r") && !quoted) {
            if (c === "\r" && next === "\n") i++;

            row.push(cell.trim());

            if (row.some(value => value !== "")) {
                rows.push(row);
            }

            row = [];
            cell = "";
        } else {
            cell += c;
        }
    }

    if (cell.length || row.length) {
        row.push(cell.trim());

        if (row.some(value => value !== "")) {
            rows.push(row);
        }
    }

    if (!rows.length) return [];

    const headers = rows[0].map(x => x.trim());

    return rows.slice(1).map(values =>
        Object.fromEntries(
            headers.map((header, index) => [
                header,
                values[index] ?? ""
            ])
        )
    );
}

/* =========================================================
   7. LOAD DATA FROM CSV FILES
========================================================= */

function loadBinsCSV(text) {
    bins = csvParse(text)
        .map(row => ({
            id: row.bin_id || row.id,
            name: row.bin_id || row.id,
            zone: row.zone || "",
            lat: Number(row.latitude),
            lng: Number(row.longitude),
            capacity: Number(row.capacity_liters) || 0,
            type: normalizeType(row.waste_stream)
        }))
        .filter(bin =>
            bin.id &&
            Number.isFinite(bin.lat) &&
            Number.isFinite(bin.lng)
        );
}

function loadTelemetryCSV(text) {
    const rows = csvParse(text);

    telemetry = rows
        .map(row => {
            const timestamp =
                row.timestamp ||
                row.datetime ||
                row.time ||
                "";

            const fillValue =
                row.fill_pct ??
                row.fill ??
                row.fill_level ??
                "";

            return {
                timestamp,
                date: timestamp.slice(0, 10),
                binId: row.bin_id || row.id || "",
                fill: Math.max(
                    0,
                    Math.min(100, Number(fillValue) || 0)
                ),
                rate: Number(row.fill_rate_pct_per_hour) || 0,
                collection: row.collection_event === "1"
            };
        })
        .filter(row => row.timestamp && row.binId);

    const dates = [...new Set(
        telemetry
            .map(row => row.date)
            .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
    )].sort();

    const daySelect = $("daySelect");

    if (!daySelect) return;

    if (!dates.length) {
        daySelect.innerHTML = `<option value="">No days found</option>`;
        selectedDate = "";
        return;
    }

    daySelect.innerHTML = dates
        .map(date =>
            `<option value="${date}">${formatDate(date)}</option>`
        )
        .join("");

    selectedDate = dates[0];
    daySelect.value = selectedDate;
}

function loadCollectionsCSV(text) {
    collections = csvParse(text);
}

function loadEventsCSV(text) {
    events = csvParse(text);
}

function loadStationsCSV(text) {
    stations = csvParse(text)
        .map(row => ({
            id: row.station_id,
            name: row.station_name || row.station_id,
            lat: Number(row.latitude),
            lng: Number(row.longitude)
        }))
        .filter(station =>
            station.id &&
            Number.isFinite(station.lat) &&
            Number.isFinite(station.lng)
        );
}

function loadTrucksCSV(text) {
    trucks = csvParse(text)
        .map(row => {
            const timestamp = row.timestamp || "";

            return {
                id: row.truck_id,
                stationId: row.station_id,
                status: row.status || "idle",
                lat: Number(row.latitude),
                lng: Number(row.longitude),
                target: row.target_bin_id || "",
                progress: Number(row.progress_pct) || 0,
                mpg: Number(row.mpg) || DEFAULT_MPG,
                timestamp,
                date: timestamp.slice(0, 10)
            };
        })
        .filter(truck =>
            truck.id &&
            Number.isFinite(truck.lat) &&
            Number.isFinite(truck.lng)
        );
}

/* =========================================================
   8. BIN + TELEMETRY HELPERS
========================================================= */

function getBinTelemetry(binId) {
    if (!selectedDate) return null;

    const matches = telemetry.filter(row =>
        row.binId === binId &&
        row.date === selectedDate
    );

    if (!matches.length) return null;

    return matches[matches.length - 1];
}

/* Get the latest fill reading for a bin on the selected day. */
function fillOf(bin) {
    const rows = telemetry
        .filter(row =>
            row.binId === bin.id &&
            (!selectedDate || row.date === selectedDate)
        )
        .sort((a, b) =>
            a.timestamp.localeCompare(b.timestamp)
        );

    if (!rows.length) return null;

    return rows[rows.length - 1].fill;
}

function getFullBins() {
    return bins.filter(bin => {
        const fill = fillOf(bin);
        console.log(
            "Checking bin:",
            bin.id,
            "fill:",
            fill
        );
        return fill !== null && fill >= 80;
    });
}

/* =========================================================
   9. TRUCK HELPERS
========================================================= */

/* Find the station assigned to a truck. */
function getStation(truck) {
    return (
        stations.find(station =>
            station.id === truck.stationId
        ) || stations[0]
    );
}

/*
   A truck may have many telemetry rows.
   We use its latest row on the selected day.
   If no row exists that day, use its latest known row.
*/
function getTruckState(id) {
    const rows = trucks
        .filter(truck => truck.id === id)
        .sort((a, b) =>
            a.timestamp.localeCompare(b.timestamp)
        );

    if (!rows.length) return null;

    const dayRows = rows.filter(truck =>
        truck.date === selectedDate
    );

    if (dayRows.length) {
        return dayRows[dayRows.length - 1];
    }

    return rows[rows.length - 1];
}

/* Return one current state for each truck ID. */
function getCurrentTrucks() {
    return [
        ...new Map(
            trucks.map(truck => [
                truck.id,
                getTruckState(truck.id)
            ])
        ).values()
    ].filter(Boolean);
}

/* Only idle/available trucks can be recommended for dispatch. */
function getAvailableTrucks() {
    return getCurrentTrucks().filter(truck => {
        const status = String(truck.status).toLowerCase();
        return status === "idle" || status === "available";
    });
}

/* Recommend the closest available truck for one bin. */
function recommendTruck(bin) {
    const available = getAvailableTrucks();

    if (!available.length) return null;

    let best = null;

    available.forEach(truck => {
        const distance = distanceMiles(truck, bin);

        if (!best || distance < best.distance) {
            best = {
                truck,
                distance,
                roundTrip: distance * 2,
                fuel: (distance * 2) / truck.mpg
            };
        }
    });

    return best;
}

/* =========================================================
   10. SAVED ROUTE HELPERS
========================================================= */

function getCurrentDayRoutes() {
    if (!selectedDate) return [];

    if (!routesByDay[selectedDate]) {
        routesByDay[selectedDate] = [];
    }

    return routesByDay[selectedDate];
}

/*
   Route IDs are unique internally.
   Route numbers are the user-facing 1-6 numbers.
   If Route 2 is deleted, the next route can reuse 2.
*/
function getNextRouteNumber() {
    const routes = getCurrentDayRoutes();

    const usedNumbers = new Set(
        routes.map(route => route.routeNumber)
    );

    for (let number = 1; number <= MAX_ROUTES; number++) {
        if (!usedNumbers.has(number)) {
            return number;
        }
    }

    return null;
}

/* =========================================================
   11. ROUTE SELECTION MODE
========================================================= */

function startRouteMode() {
    routeMode = true;
    selectedRouteBins.clear();

    $("routeBtn").textContent = "Finish Route (0)";
    $("routeBtn").classList.add("active");
    document.body.classList.add("route-selecting");

    $("pickupEfficiency").innerHTML = `
        <div class="efficiency-card">
            <b>Select bins for pickup</b>
            <div class="reason">
                Click bins on the map to add them
                to the route. Then click Finish Route.
            </div>
        </div>
    `;

    toast("Route mode active — click bins to select them.");
}

function cancelRouteMode() {
    routeMode = false;
    selectedRouteBins.clear();

    $("routeBtn").textContent = "Create Route";
    $("routeBtn").classList.remove("active");
    document.body.classList.remove("route-selecting");

    renderBins();
    showBlankEfficiency();

    toast("Route cancelled.");
}

function showBlankEfficiency() {
    const container = $("pickupEfficiency");
    if (!container) return;

    if (getCurrentDayRoutes().length > 0) {
        renderPickupEfficiency();
        return;
    }

    container.innerHTML = `
        <div class="efficiency-card">
            <b>Create a route to calculate savings.</b>
            <div class="reason">
                Fuel saved and miles saved will appear here
                after you select bins and finish a route.
            </div>
        </div>
    `;
}

function selectRouteBin(binId) {
    if (!routeMode) return;

    const bin = bins.find(item => item.id === binId);
    if (!bin) return;

    if (selectedRouteBins.has(binId)) {
        selectedRouteBins.delete(binId);
        toast(`${binId} removed from route.`);
    } else {
        selectedRouteBins.add(binId);
        toast(`${binId} added to route.`);
    }

    $("routeBtn").textContent =
        `Finish Route (${selectedRouteBins.size})`;

    renderBins();
}

/* =========================================================
   12. ROUTE OPTIMIZATION
========================================================= */

/*
   Creates ONE saved route.

   Important:
   - A route can use multiple trucks.
   - Up to 6 trucks can participate in a route.
   - The app can save up to 6 routes per day.
*/
function createOptimizedRoute() {
    const selectedBins = bins.filter(bin =>
        selectedRouteBins.has(bin.id)
    );

    if (!selectedBins.length) {
        toast("Select at least one bin first.");
        return null;
    }

    const availableTrucks = getCurrentTrucks();

    if (!availableTrucks.length) {
        toast("No trucks are available.");
        return null;
    }

    let optimizedMiles = 0;
    let optimizedFuel = 0;

    /* Use up to 6 trucks in one optimized route. */
    const truckStates = availableTrucks
        .slice(0, 6)
        .map((truck, index) => ({
            truck,
            bins: [],
            miles: 0,
            fuel: 0,
            etaMinutes: 0,
            color: ROUTE_COLORS[index],
            current: {
                lat: truck.lat,
                lng: truck.lng
            }
        }));

    const remaining = [...selectedBins];

    /*
       Greedy assignment:
       repeatedly give the next bin to whichever truck
       is currently closest to it.
    */
    while (remaining.length) {
        let best = null;

        for (const state of truckStates) {
            for (const bin of remaining) {
                const distance = distanceMiles(
                    state.current,
                    bin
                );

                if (!best || distance < best.distance) {
                    best = {
                        state,
                        bin,
                        distance
                    };
                }
            }
        }

        if (!best) break;

        const { state, bin } = best;

        state.bins.push(bin);
        state.current = {
            lat: bin.lat,
            lng: bin.lng
        };

        const index = remaining.indexOf(bin);

        if (index >= 0) {
            remaining.splice(index, 1);
        }
    }

    /* Calculate each truck's straight-line estimate. */
    truckStates.forEach(state => {
        if (!state.bins.length) return;

        let miles = 0;

        let current = {
            lat: state.truck.lat,
            lng: state.truck.lng
        };

        state.bins.forEach(bin => {
            miles += distanceMiles(current, bin);

            current = {
                lat: bin.lat,
                lng: bin.lng
            };
        });

        const station = getStation(state.truck);

        if (station) {
            miles += distanceMiles(current, station);
        }

        state.miles = miles;
        state.fuel = miles / (state.truck.mpg || DEFAULT_MPG);

        optimizedMiles += miles;
        optimizedFuel += state.fuel;
    });

    return {
        selectedBins,
        trucks: truckStates.filter(state => state.bins.length > 0),
        optimizedMiles,
        optimizedFuel,
        milesSaved: 0,
        fuelSaved: 0
    };
}

/* =========================================================
   13. OSRM ROAD ROUTING
========================================================= */

/*
   Convert a sequence of points into a real road route.
   OSRM returns actual driving-road geometry.
*/
async function getRoadRoute(points) {
    const coordinates = points
        .map(point => `${point.lng},${point.lat}`)
        .join(";");

    const url =
        `https://router.project-osrm.org/route/v1/driving/${coordinates}` +
        `?overview=full&geometries=geojson`;

    try {
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error("Routing request failed");
        }

        const data = await response.json();

        if (
            data.code !== "Ok" ||
            !data.routes ||
            !data.routes.length
        ) {
            throw new Error("No route found");
        }

        return {
            coordinates: data.routes[0].geometry.coordinates
                .map(point => [point[1], point[0]]),
            distanceMiles: data.routes[0].distance / 1609.344,
            durationMinutes: data.routes[0].duration / 60
        };
    } catch (error) {
        console.error("Road routing error:", error);

        /* Straight-line fallback if OSRM is unavailable. */
        let miles = 0;

        for (let i = 1; i < points.length; i++) {
            miles += distanceMiles(points[i - 1], points[i]);
        }

        return {
            coordinates: points.map(point => [
                point.lat,
                point.lng
            ]),
            distanceMiles: miles,
            durationMinutes: (miles / 20) * 60
        };
    }
}

/* =========================================================
   14. NORMAL GARBAGE-DAY BASELINE
========================================================= */

/*
   Calculate the baseline once for the selected day.

   Baseline behavior:
   - Uses up to 6 trucks.
   - Includes every campus bin.
   - Gives each truck a nearby starting bin.
   - Distributes the remaining bins approximately evenly.
   - Starts at the truck's current position.
   - Returns to that truck's station.
*/
async function calculateBaselineForDay() {
    if (!selectedDate) {
        return {
            miles: 0,
            fuel: 0,
            routes: []
        };
    }

    /* Reuse the existing baseline if we already calculated it. */
    if (baselineByDay[selectedDate]) {
        return {
            ...baselineByDay[selectedDate],
            routes: baselineRoutesByDay[selectedDate] || []
        };
    }

    let baselineMiles = 0;
    let baselineFuel = 0;
    const baselineRoutes = [];

    const baselineTrucks = getCurrentTrucks().slice(0, 6);
    const allBaselineBins = bins.slice();

    if (!baselineTrucks.length || !allBaselineBins.length) {
        baselineByDay[selectedDate] = {
            miles: 0,
            fuel: 0
        };

        baselineRoutesByDay[selectedDate] = [];

        return {
            miles: 0,
            fuel: 0,
            routes: []
        };
    }

    const unassignedBins = new Set(allBaselineBins);

    const assignments = baselineTrucks.map(truck => ({
        truck,
        bins: []
    }));

    /* Give every truck at least one nearby bin. */
    for (let i = 0; i < baselineTrucks.length; i++) {
        if (unassignedBins.size === 0) break;

        const truck = baselineTrucks[i];
        let closestBin = null;
        let closestDistance = Infinity;

        for (const bin of unassignedBins) {
            const distance = distanceMiles(truck, bin);

            if (distance < closestDistance) {
                closestDistance = distance;
                closestBin = bin;
            }
        }

        if (closestBin) {
            assignments[i].bins.push(closestBin);
            unassignedBins.delete(closestBin);
        }
    }

    /* Distribute remaining bins approximately evenly. */
    while (unassignedBins.size > 0) {
        let bestTruck = null;
        let bestBin = null;
        let bestDistance = Infinity;

        for (const assignment of assignments) {
            const maxBins = Math.ceil(
                allBaselineBins.length / assignments.length
            );

            if (assignment.bins.length >= maxBins) {
                continue;
            }

            for (const bin of unassignedBins) {
                let nearestAssignedDistance = Infinity;

                for (const assignedBin of assignment.bins) {
                    const distance = distanceMiles(
                        assignedBin,
                        bin
                    );

                    if (distance < nearestAssignedDistance) {
                        nearestAssignedDistance = distance;
                    }
                }

                if (nearestAssignedDistance < bestDistance) {
                    bestDistance = nearestAssignedDistance;
                    bestTruck = assignment;
                    bestBin = bin;
                }
            }
        }

        /* Safety fallback if no assignment was selected. */
        if (!bestTruck || !bestBin) {
            bestTruck = assignments.reduce((a, b) =>
                a.bins.length <= b.bins.length ? a : b
            );

            bestBin = [...unassignedBins][0];
        }

        bestTruck.bins.push(bestBin);
        unassignedBins.delete(bestBin);
    }

    /* Ask OSRM for each baseline truck's complete route. */
    for (const assignment of assignments) {
        const truck = assignment.truck;
        const assignedBins = assignment.bins;

        if (!assignedBins.length) continue;

        const points = [
            {
                lat: truck.lat,
                lng: truck.lng
            }
        ];

        assignedBins.forEach(bin => {
            points.push({
                lat: bin.lat,
                lng: bin.lng
            });
        });

        const station = getStation(truck);

        if (station) {
            points.push({
                lat: station.lat,
                lng: station.lng
            });
        }

        const roadRoute = await getRoadRoute(points);

        baselineRoutes.push({
            truck,
            bins: assignedBins,
            coordinates: roadRoute.coordinates,
            miles: roadRoute.distanceMiles,
            durationMinutes: roadRoute.durationMinutes
        });

        baselineMiles += roadRoute.distanceMiles;
        baselineFuel +=
            roadRoute.distanceMiles /
            (truck.mpg || DEFAULT_MPG);
    }

    baselineByDay[selectedDate] = {
        miles: baselineMiles,
        fuel: baselineFuel
    };

    baselineRoutesByDay[selectedDate] = baselineRoutes;

    return {
        miles: baselineMiles,
        fuel: baselineFuel,
        routes: baselineRoutes
    };
}

/* =========================================================
   15. DRAW A SAVED ROUTE
========================================================= */

async function drawCreatedRoute(route) {
    /* Unique internal ID. */
    route.id = nextRouteId++;

    /* User-facing number from 1-6. */
    route.routeNumber =
        route.routeNumber || getNextRouteNumber();

    const routeGroup = L.layerGroup().addTo(routeLayer);
    route.layer = routeGroup;

    route.roadMiles = 0;
    route.etaMinutes = 0;
    route.roadFuel = 0;

    /* Draw each truck's part of the optimized route. */
    for (const truckState of route.trucks) {
        const points = [
            {
                lat: truckState.truck.lat,
                lng: truckState.truck.lng
            }
        ];

        truckState.bins.forEach(bin => {
            points.push({
                lat: bin.lat,
                lng: bin.lng
            });
        });

        const station = getStation(truckState.truck);

        if (station) {
            points.push({
                lat: station.lat,
                lng: station.lng
            });
        }

        const roadRoute = await getRoadRoute(points);

        truckState.roadMiles = roadRoute.distanceMiles;
        truckState.etaMinutes = roadRoute.durationMinutes;

        route.roadMiles += roadRoute.distanceMiles;
        route.etaMinutes += roadRoute.durationMinutes;

        route.roadFuel +=
            roadRoute.distanceMiles /
            (truckState.truck.mpg || DEFAULT_MPG);

        const line = L.polyline(
            roadRoute.coordinates,
            {
                color: ROUTE_COLORS[
                    (route.routeNumber - 1) % ROUTE_COLORS.length
                ],
                weight: 6,
                opacity: 0.85
            }
        );

        line.addTo(routeGroup);

        line.bindPopup(`
            <b>Route ${route.routeNumber}</b>
            <br>
            ${roadRoute.distanceMiles.toFixed(2)} miles
            <br>
            ETA: ${formatETA(roadRoute.durationMinutes)}
        `);
    }

    route.optimizedMiles = route.roadMiles;
    route.optimizedFuel = route.roadFuel;

    /*
       Calculate the baseline only once for this day.
    */
    const baseline = await calculateBaselineForDay();

    route.baselineMiles = baseline.miles;
    route.baselineFuel = baseline.fuel;

    route.milesSaved = Math.max(
        0,
        route.baselineMiles - route.optimizedMiles
    );

    route.fuelSaved = Math.max(
        0,
        route.baselineFuel - route.optimizedFuel
    );

    if (!routesByDay[selectedDate]) {
        routesByDay[selectedDate] = [];
    }

    routesByDay[selectedDate].push(route);

    renderCreatedRoutes();
    renderPickupEfficiency();

    toast(`Route ${route.routeNumber} created.`);

    console.log("Created route:", route);
}

/* =========================================================
   16. ROUTE DISPLAY
========================================================= */

async function renderDayRoutes() {
    routeLayer.clearLayers();

    const routes = getCurrentDayRoutes();

    /*
       Saved route objects already have Leaflet layers.
       Add those layers back when switching days.
    */
    for (const route of routes) {
        if (route.layer) {
            route.layer.addTo(routeLayer);
        }
    }

    renderCreatedRoutes();
    renderPickupEfficiency();
}

function renderCreatedRoutes() {
    const container = $("createdRoutes");
    if (!container) return;

    const routes = getCurrentDayRoutes();

    if (!routes.length) {
        container.innerHTML = `
            <div class="empty-routes">
                No routes created for this day.
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="routes-title">
            Saved Routes — ${formatDate(selectedDate)}
        </div>

        ${routes.map(route => `
            <div class="saved-route">

                <div class="saved-route-header">
                    <strong>
                        Route ${route.routeNumber}
                    </strong>

                    <button
                        class="delete-route-btn"
                        data-route-id="${route.id}"
                    >
                        Delete
                    </button>
                </div>

                <div class="route-stats">
                    <span>
                        ${route.optimizedMiles.toFixed(2)} mi
                    </span>

                    <span>
                        ${route.optimizedFuel.toFixed(2)} gal
                    </span>

                    <span>
                        ${formatETA(route.etaMinutes)}
                    </span>
                </div>

                <div class="route-savings">
                    Saved:
                    ${route.milesSaved.toFixed(2)} mi
                    /
                    ${route.fuelSaved.toFixed(2)} gal
                </div>

                <!-- Only show bin counts. No truck IDs. -->
                <div class="route-trucks">
                    ${route.trucks.map(state => `
                        <div>
                            ${state.bins.length}
                            bin${state.bins.length === 1 ? "" : "s"}
                        </div>
                    `).join("")}
                </div>

            </div>
        `).join("")}
    `;

    container
        .querySelectorAll(".delete-route-btn")
        .forEach(button => {
            button.addEventListener("click", () => {
                deleteRoute(
                    Number(button.dataset.routeId)
                );
            });
        });
}

function deleteRoute(routeId) {
    const routes = getCurrentDayRoutes();

    const routeIndex = routes.findIndex(
        route => route.id === routeId
    );

    if (routeIndex === -1) return;

    const route = routes[routeIndex];
    const displayNumber = route.routeNumber;

    if (route.layer) {
        routeLayer.removeLayer(route.layer);
    }

    routes.splice(routeIndex, 1);

    renderCreatedRoutes();
    renderPickupEfficiency();

    toast(`Route ${displayNumber} deleted.`);
}

/* =========================================================
   17. PICKUP EFFICIENCY
========================================================= */

function renderPickupEfficiency() {
    const container = $("pickupEfficiency");
    if (!container) return;

    const routes = getCurrentDayRoutes();

    if (!routes.length) {
        container.innerHTML = `
            <div class="empty-routes">
                Create a route to see pickup efficiency.
            </div>
        `;
        return;
    }

    const baseline = baselineByDay[selectedDate] || {
        miles: 0,
        fuel: 0
    };

    let totalOptimizedMiles = 0;
    let totalOptimizedFuel = 0;

    routes.forEach(route => {
        totalOptimizedMiles += route.optimizedMiles || 0;
        totalOptimizedFuel += route.optimizedFuel || 0;
    });

    const milesSaved = Math.max(
        0,
        baseline.miles - totalOptimizedMiles
    );

    const fuelSaved = Math.max(
        0,
        baseline.fuel - totalOptimizedFuel
    );

    const efficiency = baseline.miles > 0
        ? (milesSaved / baseline.miles) * 100
        : 0;

    container.innerHTML = `
        <div class="efficiency-grid">

            <div class="efficiency-card">
                <span>Routes</span>
                <strong>${routes.length}</strong>
            </div>

            <div class="efficiency-card">
                <span>Baseline Miles</span>
                <strong>${baseline.miles.toFixed(2)}</strong>
            </div>

            <div class="efficiency-card">
                <span>Optimized Miles</span>
                <strong>${totalOptimizedMiles.toFixed(2)}</strong>
            </div>

            <div class="efficiency-card">
                <span>Miles Saved</span>
                <strong>${milesSaved.toFixed(2)}</strong>
            </div>

            <div class="efficiency-card">
                <span>Fuel Saved</span>
                <strong>${fuelSaved.toFixed(2)} gal</strong>
            </div>

            <div class="efficiency-card efficiency-main">
                <span>Pickup Efficiency</span>
                <strong>${efficiency.toFixed(1)}%</strong>
            </div>

        </div>
    `;
}

/* =========================================================
   18. RENDER STATIONS
========================================================= */

function renderStations() {
    stationLayer.clearLayers();

    stations.forEach(station => {
        const icon = L.divIcon({
            className: "",
            html: `<div class="station-icon">🏭</div>`,
            iconSize: [40, 40],
            iconAnchor: [20, 20]
        });

        const marker = L.marker(
            [station.lat, station.lng],
            { icon }
        ).addTo(stationLayer);

        marker.bindPopup(`
            <b>${esc(station.name)}</b>
            <br>
            <small>Waste Management Station</small>
        `);
    });
}

/* =========================================================
   19. RENDER TRUCKS
========================================================= */

function renderTrucks() {
    truckLayer.clearLayers();

    getCurrentTrucks().forEach(truck => {
        const enroute =
            String(truck.status).toLowerCase() === "en route";

        const icon = L.divIcon({
            className: "",
            html: `
                <div class="truck-icon ${enroute ? "enroute" : ""}">
                    🚛
                </div>
            `,
            iconSize: [42, 42],
            iconAnchor: [21, 21]
        });

        L.marker(
            [truck.lat, truck.lng],
            { icon }
        )
            .addTo(truckLayer)
            .bindPopup(`
                <b>${esc(truck.id)}</b>
                <br>
                Status: ${esc(truck.status)}
                <br>
                MPG: ${truck.mpg.toFixed(1)}
                <br>
                Target: ${esc(truck.target || "None")}
            `);
    });
}

/* =========================================================
   20. RENDER BINS
========================================================= */

function renderBins() {
    binLayer.clearLayers();
    markers.clear();

    const types = activeTypes();
    const onlyFull = $("onlyFull").checked;

    bins.forEach(bin => {
        if (!types.includes(bin.type)) return;

        const fill = fillOf(bin);

        if (onlyFull && !(fill !== null && fill >= 80)) {
            return;
        }

        const level = levelOf(fill);
        const color = COLORS[bin.type];
        const isSelected = selectedRouteBins.has(bin.id);

        const selectedStyle = isSelected
            ? `
                outline:4px solid #ffcb05;
                box-shadow:0 0 0 5px #00274c;
              `
            : "";

        const icon = L.divIcon({
            className: "",
            html: `
                <div
                    class="badge ${level}"
                    style="border-color:${color};${selectedStyle}"
                >
                    ${fill === null ? "?" : Math.round(fill) + "%"}
                </div>
            `,
            iconSize: [34, 34],
            iconAnchor: [17, 17]
        });

        const marker = L.marker(
            [bin.lat, bin.lng],
            { icon }
        ).addTo(binLayer);

        marker.on("click", () => {
            if (routeMode) {
                selectRouteBin(bin.id);
                return;
            }

            sidebarSelectedBinId = null;
            marker.openPopup();
        });

        marker.bindPopup(() => {
            const recommendation =
                sidebarSelectedBinId !== bin.id &&
                    fill !== null &&
                    fill >= 80
                    ? recommendTruck(bin)
                    : null;

            const selectedText = isSelected
                ? `
                    <div style="color:#3aa76d;font-weight:700;margin-top:6px;">
                        ✓ Selected for route
                    </div>
                  `
                : "";

            const routeButton = routeMode
                ? `
                    <button
                        class="dispatch-btn"
                        onclick="selectRouteBin('${esc(bin.id)}')"
                    >
                        ${isSelected ? "Remove from route" : "Add to route"}
                    </button>
                  `
                : "";

            const dispatchSection = !routeMode && recommendation
                ? `
                    <div class="dispatch-status">
                        Recommended:
                        <b>${esc(recommendation.truck.id)}</b>
                        <br>
                        ${recommendation.roundTrip.toFixed(2)} mi round trip
                        <br>
                        ${recommendation.fuel.toFixed(2)} gal estimated
                    </div>

                    <button
                        class="dispatch-btn"
                        data-dispatch="${esc(bin.id)}"
                    >
                        Dispatch ${esc(recommendation.truck.id)}
                    </button>
                  `
                : "";

            return `
                <b>${esc(bin.id)}</b>
                <br>

                <small>
                    ${esc(LABELS[bin.type])} • ${esc(bin.zone)}
                </small>

                <div
                    style="
                        margin:8px 0;
                        height:8px;
                        background:#e3e6eb;
                        border-radius:4px;
                        overflow:hidden
                    "
                >
                    <i
                        style="
                            display:block;
                            height:100%;
                            width:${fill ?? 0}%;
                            background:${LEVEL_COLOR[level]}
                        "
                    ></i>
                </div>

                <b>
                    ${fill === null
                    ? "No telemetry"
                    : Math.round(fill) + "% full"
                }
                </b>

                ${selectedText}
                ${routeButton}
                ${dispatchSection}
            `;
        });

        markers.set(bin.id, marker);
    });
}


/* =========================================================
   21. SUMMARY + BIN LIST + EVENTS
========================================================= */

function renderSummary() {
    const visibleBins = bins.filter(bin =>
        activeTypes().includes(bin.type)
    );

    const fullBins = visibleBins.filter(bin => {
        const fill = fillOf(bin);
        return fill !== null && Number(fill) >= 80;
    });

    const values = visibleBins
        .map(fillOf)
        .filter(Number.isFinite);

    const average = values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : 0;

    $("count").textContent = `(${visibleBins.length})`;

    $("summary").innerHTML = `
        <div class="stat">
            <span>Selected day</span>
            <b>${esc(formatDate(selectedDate))}</b>
        </div>

        <div class="stat">
            <span>Bins shown</span>
            <b>${visibleBins.length}</b>
        </div>

        <div class="stat">
            <span>Needs pickup</span>
            <b>${fullBins.length}</b>
        </div>

        <div class="stat">
            <span>Average fill</span>
            <b>${average.toFixed(0)}%</b>
        </div>

        <div class="stat">
            <span>Trucks visible</span>
            <b>${getCurrentTrucks().length}</b>
        </div>

        <div class="stat">
            <span>Stations visible</span>
            <b>${stations.length}</b>
        </div>
    `;
}

function renderList() {
    const fullBins = getFullBins().sort(
        (a, b) => fillOf(b) - fillOf(a)
    );

    if (!fullBins.length) {
        $("list").innerHTML = `
            <small>No bins currently need pickup.</small>
        `;
        return;
    }

    $("list").innerHTML = fullBins.map(bin => `
        <button
            class="row"
            data-select-bin="${esc(bin.id)}"
        >
            <span>${esc(bin.id)}</span>
            <b>${Math.round(fillOf(bin))}%</b>
        </button>
    `).join("");
}

function renderEvents() {
    const dayEvents = events.filter(event =>
        (event.timestamp || "").slice(0, 10) === selectedDate
    );

    const eventBox = $("eventBox");

    if (!eventBox) return;

    eventBox.style.display = dayEvents.length ? "block" : "none";

    eventBox.innerHTML = dayEvents
        .slice(-3)
        .map(event => `
            <div>
                <b>${esc(event.event_type || "Event")}</b>:
                ${esc(event.description || "Campus event")}
            </div>
        `)
        .join("");
}

/* =========================================================
   22. DISPATCH PANEL + SINGLE-TRUCK DISPATCH
========================================================= */

function renderDispatchPanel() {
    const panel = $("dispatchPanel");
    if (!panel) return;

    panel.innerHTML = `
        <div class="route-help">
            <strong>Create a route</strong>
            <p>
                Click <b>Create Route</b>, select the bins
                you want to collect, then click <b>Finish Route</b>.
            </p>
        </div>
    `;
}

function dispatchTruck(binId) {
    const bin = bins.find(item => item.id === binId);
    const recommendation = bin ? recommendTruck(bin) : null;

    if (!recommendation) {
        toast("No idle truck is available.");
        return;
    }

    const station = getStation(recommendation.truck);

    const points = station
        ? [
            [station.lat, station.lng],
            [bin.lat, bin.lng],
            [station.lat, station.lng]
        ]
        : [
            [recommendation.truck.lat, recommendation.truck.lng],
            [bin.lat, bin.lng]
        ];

    L.polyline(points, {
        color: "#00274c",
        weight: 5,
        opacity: 0.85,
        className: "route-line"
    }).addTo(routeLayer);

    dispatches.push({
        date: selectedDate,
        binId,
        truckId: recommendation.truck.id,
        miles: recommendation.roundTrip,
        fuel: recommendation.fuel
    });

    toast(
        `${recommendation.truck.id} assigned to ${binId}. ` +
        `Estimated fuel: ${recommendation.fuel.toFixed(2)} gallons.`
    );
}

/* =========================================================
   23. BASELINE BUTTON
========================================================= */

async function toggleBaselineRoutes() {
    const baseline = await calculateBaselineForDay();
    const routes = baseline.routes;

    if (!routes.length) {
        toast(
            "Create or load data first so baseline routes can be calculated."
        );
        return;
    }

    if (baselineVisible) {
        baselineLayer.clearLayers();
        baselineVisible = false;
        $("baselineBtn").textContent = "Show Baseline Routes";
        toast("Baseline routes hidden.");
        return;
    }

    baselineLayer.clearLayers();

    routes.forEach((route, index) => {
        const line = L.polyline(
            route.coordinates,
            {
                color: ROUTE_COLORS[
                    index % ROUTE_COLORS.length
                ],
                weight: 5,
                opacity: 0.55,
                dashArray: "10, 8"
            }
        );

        line.addTo(baselineLayer);

        line.bindPopup(`
            <b>Baseline Route ${index + 1}</b>
            <br>
            Bins: ${route.bins.length}
            <br>
            Distance: ${route.miles.toFixed(2)} miles
            <br>
            ETA: ${formatETA(route.durationMinutes)}
        `);
    });

    baselineVisible = true;
    $("baselineBtn").textContent = "Hide Baseline Routes";

    toast(`${routes.length} baseline routes displayed.`);
}

/* =========================================================
   24. UPDATE EVERYTHING
========================================================= */

function update() {
    renderStations();
    renderTrucks();
    renderBins();
    renderSummary();
    renderList();
    renderEvents();
    renderCreatedRoutes();
    renderPickupEfficiency();
}

/* =========================================================
   25. FILE DETECTION + UPLOAD
========================================================= */

async function handleFiles(files) {
    for (const file of files) {
        const text = await file.text();
        const rows = csvParse(text);

        if (!rows.length) continue;

        const keys = Object.keys(rows[0])
            .map(key => key.toLowerCase().trim());

        if (
            keys.includes("bin_id") &&
            keys.includes("waste_stream")
        ) {
            loadBinsCSV(text);
        } else if (
            keys.includes("bin_id") &&
            (
                keys.includes("fill_pct") ||
                keys.includes("fill") ||
                keys.includes("fill_level")
            )
        ) {
            loadTelemetryCSV(text);
        } else if (
            keys.includes("station_id") &&
            keys.includes("station_name")
        ) {
            loadStationsCSV(text);
        } else if (
            keys.includes("truck_id") &&
            keys.includes("progress_pct")
        ) {
            loadTrucksCSV(text);
        } else if (keys.includes("collection_id")) {
            loadCollectionsCSV(text);
        } else if (
            keys.includes("event_type") &&
            keys.includes("description")
        ) {
            loadEventsCSV(text);
        }
    }

    update();

    if (telemetry.length > 0) {
        const dates = [
            ...new Set(telemetry.map(row => row.date))
        ].sort();

        toast(
            `Data loaded — ${dates.length} day${dates.length === 1 ? "" : "s"} detected.`
        );
    } else {
        toast("Data loaded successfully.");
    }
}

/* =========================================================
   26. FILE INPUT
========================================================= */

$("file").addEventListener("change", event => {
    handleFiles(event.target.files);
});

/* =========================================================
   27. DAY DROPDOWN
========================================================= */

$("daySelect").addEventListener("change", async event => {
    selectedDate = event.target.value;

    /* Remove the previous day's optimized route lines. */
    routeLayer.clearLayers();

    /* Add the selected day's saved routes back. */
    await renderDayRoutes();

    /* Baseline belongs to the selected day too. */
    baselineLayer.clearLayers();
    baselineVisible = false;
    $("baselineBtn").textContent = "Show Baseline Routes";

    update();
});

/* =========================================================
   28. FILTERS
========================================================= */

document
    .querySelectorAll(
        "#controls input[data-type], #onlyFull"
    )
    .forEach(input => {
        input.addEventListener("change", update);
    });

/* =========================================================
   29. FIND NEAREST AVAILABLE BIN
========================================================= */

$("nearestBtn").addEventListener("click", () => {
    if (!navigator.geolocation) {
        toast("Location is not supported by this browser.");
        return;
    }

    toast("Finding your location...");

    navigator.geolocation.getCurrentPosition(
        async position => {
            const userLat = position.coords.latitude;
            const userLng = position.coords.longitude;

            const availableBins = bins
                .map(bin => {
                    const data = getBinTelemetry(bin.id);

                    return {
                        bin,
                        fill: data ? data.fill : 0
                    };
                })
                .filter(item => item.fill < 80);

            if (!availableBins.length) {
                toast("There are no available bins nearby.");
                return;
            }

            let closest = null;
            let closestDistance = Infinity;

            for (const item of availableBins) {
                const distance = distanceMiles(
                    {
                        lat: userLat,
                        lng: userLng
                    },
                    item.bin
                );

                if (distance < closestDistance) {
                    closestDistance = distance;
                    closest = item;
                }
            }

            if (!closest) {
                toast("Could not find an available bin.");
                return;
            }

            const bin = closest.bin;

            /* Clear only the temporary route layer. */
            routeLayer.clearLayers();

            const roadRoute = await getRoadRoute([
                {
                    lat: userLat,
                    lng: userLng
                },
                {
                    lat: bin.lat,
                    lng: bin.lng
                }
            ]);

            const line = L.polyline(
                roadRoute.coordinates,
                {
                    color: "#2563eb",
                    weight: 7,
                    opacity: 0.9
                }
            );

            line.addTo(routeLayer);

            line.bindPopup(`
                <b>Nearest available bin</b>
                <br><br>
                Bin: ${esc(bin.id)}
                <br>
                Fill: ${closest.fill.toFixed(0)}%
                <br>
                Distance: ${roadRoute.distanceMiles.toFixed(2)} miles
                <br>
                ETA: ${formatETA(roadRoute.durationMinutes)}
            `).openPopup();

            map.fitBounds(line.getBounds(), {
                padding: [50, 50]
            });

            toast(
                `Nearest available bin is ${roadRoute.distanceMiles.toFixed(2)} miles away.`
            );
        },
        error => {
            if (error.code === 1) {
                toast(
                    "Please allow location access to find a nearby bin."
                );
            } else {
                toast("Could not determine your location.");
            }
        }
    );
});

/* =========================================================
   30. CREATE / FINISH ROUTE BUTTON
========================================================= */

$("routeBtn").addEventListener("click", async () => {
    const existingRoutes =
        routesByDay[selectedDate] || [];

    /* -----------------------------------------------
       START ROUTE MODE
    ------------------------------------------------ */
    if (!routeMode) {
        if (existingRoutes.length >= MAX_ROUTES) {
            toast("All trucks are currently out.");
            return;
        }

        startRouteMode();
        return;
    }

    /* -----------------------------------------------
       FINISH ROUTE
    ------------------------------------------------ */
    if (selectedRouteBins.size === 0) {
        toast("Select at least one bin first.");
        return;
    }

    /* Safety check. */
    if (existingRoutes.length >= MAX_ROUTES) {
        toast("All trucks are currently out.");
        return;
    }

    const route = createOptimizedRoute();

    if (!route) return;

    routeMode = false;

    $("routeBtn").textContent = "Create Route";
    $("routeBtn").classList.remove("active");
    document.body.classList.remove("route-selecting");

    renderTrucks();

    await drawCreatedRoute(route);

    /* Clear selected bins after the route is saved. */
    selectedRouteBins.clear();
    renderBins();
});

/* =========================================================
   31. DISPATCH / BIN LIST CLICKS
========================================================= */

document.addEventListener("click", event => {
    const dispatchButton = event.target.closest(
        "[data-dispatch]"
    );

    if (dispatchButton) {
        dispatchTruck(dispatchButton.dataset.dispatch);
        return;
    }

    const binButton = event.target.closest(
        "[data-select-bin]"
    );

    if (binButton) {
        const bin = bins.find(item =>
            item.id === binButton.dataset.selectBin
        );

        const marker = markers.get(
            binButton.dataset.selectBin
        );

        if (bin && marker) {
            sidebarSelectedBinId = bin.id;
            map.setView([bin.lat, bin.lng], 16);
            marker.openPopup();
        }
    }
});

/* =========================================================
   32. DRAG + DROP FILE UPLOAD
========================================================= */

["dragenter", "dragover"].forEach(type => {
    document.addEventListener(type, event => {
        event.preventDefault();
        $("drop").style.display = "flex";
    });
});

["dragleave", "drop"].forEach(type => {
    document.addEventListener(type, event => {
        event.preventDefault();

        if (type === "drop") {
            handleFiles(event.dataTransfer.files);
        }

        $("drop").style.display = "none";
    });
});

/* =========================================================
   33. BASELINE BUTTON EVENT
========================================================= */

$("baselineBtn").addEventListener("click", toggleBaselineRoutes);

/* =========================================================
   34. START APPLICATION
========================================================= */

async function loadDefaultData() {
    const names = ["bins", "stations", "trucks"];

    const files = await Promise.all(
        names.map(async name => {
            const res = await fetch(`data/${name}.csv`);
            if (!res.ok) throw new Error(`${name}.csv not found`);
            const text = await res.text();
            return { text: async () => text };   // looks like a File to handleFiles
        })
    );

    await handleFiles(files);   // your existing detection + loaders + update()
    toast("Upload telemetry to see bin fill levels.");
}

loadDefaultData().catch(err => {
    console.error(err);
    toast("Could not load default data — upload CSV files instead.");
    update();
});

console.log("Campus Bin Map loaded.");