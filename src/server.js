const express = require("express");
const dotenv = require("dotenv");
dotenv.config();

const errorHandler = require("./middleware/error.middleware");
const applySecurityAndMiddlewares = require("./security/security.setup");
const authRoutes = require("./routes/Auth/auth.route");
const productionRoutes = require('./routes/MachineEfficiency/efficiency.route');
const productionTrendRoutes = require('./routes/ProductionTrend/productionTrend.route');
const costAnalysisRoutes = require('./routes/costAnalysis.routes');
const inventoryRoutes = require('./routes/Inventory/inventory.route');
const productionPlanningRoutes = require('./routes/ProductionPlanning/productionPlanning.route');
const dashboardRoutes = require('./routes/Dashboard/dashboard.route');
const productionOrdersRoutes = require('./routes/ProductionOrders/productionOrders.route');
const complaintsRoutes = require('./routes/Complaints/complaints.route');
const app = express();

applySecurityAndMiddlewares(app);

// ── Custom Request Logger ────────────────────────────────
app.use((req, res, next) => {
  console.log(`\n--- 📥 NEW REQUEST: [${req.method}] ${req.url} ---`);
  if (req.params && Object.keys(req.params).length > 0) console.log("Params:", req.params);
  if (req.query && Object.keys(req.query).length > 0) console.log("Query:", req.query);
  if (req.body && Object.keys(req.body).length > 0) {
    const safeBody = { ...req.body };
    if (safeBody.password) safeBody.password = "***HIDDEN***";
    console.log("Body:", safeBody);
  }
  console.log("------------------------------------------");
  next();
});
app.get("/api/health", (req, res) => {
  res.json({ 
    success: true, 
    message: "WMS API is running",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/machine-efficiency", productionRoutes);
app.use("/api/production-trend", productionTrendRoutes);
app.use("/api/cost-analysis", costAnalysisRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/production-planning", productionPlanningRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/production-orders", productionOrdersRoutes);
app.use("/api/complain", complaintsRoutes);
app.use(errorHandler);

const PORT = process.env.PORT || 3001;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 WMS Server running on: http://localhost:${PORT}`);
  setInterval(() => {}, 1000 * 60 * 60);
});
