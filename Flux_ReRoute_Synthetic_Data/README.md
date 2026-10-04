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
![Uploading image.png…]()

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
