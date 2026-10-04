# FLUX

## Infrastructure that adapts.

FLUX is a campus waste-management digital twin designed to help campus waste systems adapt before problems happen.

Instead of relying entirely on fixed garbage-collection schedules, FLUX uses simulated waste-bin telemetry to identify which bins need attention and helps optimize collection routes.

---

## What FLUX Does

FLUX combines campus waste data, mapping, and route optimization into one interactive system.

### Key Features

- 🗺️ Interactive campus waste map
- 🗑️ Real-time-style bin fill visualization
- 🚛 Garbage truck visualization
- 📍 Collection station visualization
- 📊 Historical bin telemetry
- 🔴 High-priority pickup identification
- 🛣️ Road-following pickup routes
- 🚛 Multi-truck route optimization
- 📋 Multiple saved pickup routes
- 📈 Pickup efficiency comparison
- ⛽ Estimated fuel savings
- 🌱 Sustainability-focused infrastructure planning

---

# The Problem

Campus waste collection is often based on fixed schedules.

For example:

> "Every truck visits every bin every Tuesday."

But waste generation isn't uniform.

Some bins fill much faster than others, while other bins may still have plenty of capacity.

This can result in:

- Unnecessary truck trips
- Unnecessary fuel consumption
- Increased mileage
- Inefficient use of collection crews
- Overflowing bins in high-traffic areas

FLUX approaches the problem differently.

Instead of asking:

> "Which bins do we normally collect?"

FLUX asks:

> "Which bins actually need attention right now?"

---

# Our Solution

FLUX creates a digital representation of campus waste infrastructure.

The system combines:

```text
Bin Data
   +
Telemetry
   +
Truck Locations
   +
Collection Stations
   +
Road Routing
        ↓
      FLUX
        ↓
Optimized Collection Routes
        ↓
Less Mileage + Less Fuel + Fewer Unnecessary Trips

```
# How to Run FLUX

## 1. Download the Project

Clone the repository:

Or download the repository as a ZIP file and extract it.

## 2. Open the Project in VS Code

Open the `FLUX` folder in Visual Studio Code.

Your project should contain:

```text
FLUX/
├── homepage.html
├── homepage.css
├── homepage.js
├── map.html
├── map.css
├── map.js
├── bins.csv
├── telemetry.csv
├── stations.csv
└── trucks.csv
```

## 3. Install Live Server

In VS Code:

1. Open the **Extensions** tab.
2. Search for **Live Server**.
3. Install **Live Server** by Ritwick Dey.

## 4. Start FLUX

Open `homepage.html`.

Right-click inside the file and select:

**Open with Live Server**

Your browser should automatically open FLUX.

## 5. Running Data

On the map page, click **Upload Files** and select:

```text
telemetry.csv
```

For the demo, we generated 5 days of fill-level readings for bins across campus.

### Using your own data

FLUX works with any CSV that follows the same format as `telemetry.csv`. To use your own:

1. Make a CSV with these columns (the header row must match exactly):

```text
   timestamp,bin_id,fill_level
   2025-01-15 08:00,BIN_001,42
   2025-01-15 09:00,BIN_001,47
```

   - `timestamp`: when the reading was taken
   - `bin_id`: must match a bin ID in `data/bins.csv`
   - `fill_level`: how full the bin is (0-100%)

2. If you are adding new bins, also add them to `bins.csv` with their location so they appear on the map.
3. Click **Upload Files** on the map page and select your CSV.

Any list of bins works, whether it's a campus, a city, or a single building, as long as each bin has an ID, a location, and readings over time.

### Where the data comes from in the real world

The CSV upload is a stand-in for live data. Our goal is to put low-cost sensors in trash bins that measure fill level and send readings automatically:

1. **Sensor:** an ultrasonic sensor inside the lid measures the distance to the trash and converts it to a fill percentage.
2. **Connectivity:** a small microcontroller sends the reading over Wi-Fi or a low-power network (such as LoRaWAN or cellular).
3. **Backend:** the reading is sent to the FLUX server, which stores it in the same format as `telemetry.csv`.
4. **Dashboard:** the map updates as new readings arrive, and FLUX uses them to flag full bins and re-route trucks.

The app reads the same data format either way, so switching from uploaded CSVs to live sensors only changes how the data arrives, not how FLUX uses it.
