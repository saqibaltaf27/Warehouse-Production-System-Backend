const router = require("express").Router();
const inventoryController = require("../../controller/Inventory/inventory.controller");

// ── Dashboard ────────────────────────────────────────────────
router.get("/filters", inventoryController.getInventoryFilters);
router.get("/dashboard/cards", inventoryController.getInventoryDashboardCards);
router.get("/dashboard/items", inventoryController.getInventoryDashboardItems);

// ── Item Master ──────────────────────────────────────────────
router.get("/items", inventoryController.getInventoryItems);
router.get("/items/:itemCode/details", inventoryController.getItemDetails);
router.get("/items/:itemCode/history", inventoryController.getItemHistory);

// ── Goods Receipt ────────────────────────────────────────────
router.post("/goods-receipt", inventoryController.createGoodsReceipt);
router.get("/goods-receipt", inventoryController.getGoodsReceipts);
router.get("/goods-receipt/:docEntry", inventoryController.getGoodsReceiptById);

// ── Goods Issue ──────────────────────────────────────────────
router.post("/goods-issue", inventoryController.createGoodsIssue);
router.get("/goods-issue", inventoryController.getGoodsIssues);
router.get("/goods-issue/:docEntry", inventoryController.getGoodsIssueById);

// ── Inventory Transfer ───────────────────────────────────────
router.post("/transfers", inventoryController.createInventoryTransfer);
router.get("/transfers", inventoryController.getInventoryTransfers);
router.get("/transfers/:docEntry", inventoryController.getInventoryTransferById);

// ── Delivery Challan ─────────────────────────────────────────
router.get("/delivery-challans", inventoryController.getDeliveryChallans);
router.get("/delivery-challans/:docEntry", inventoryController.getDeliveryChallanById);

// ── Incident Reporting ──────────────────────────────────────────
router.get("/incident-reports", inventoryController.getIncidentReports);
router.post("/incident-reports", inventoryController.createIncidentReport);
router.get("/user-info", inventoryController.getUserInfo);

// ── Training Calendar ───────────────────────────────────────────
router.get("/trainings", inventoryController.getTrainings);
router.post("/trainings", inventoryController.createTraining);

// ── Lookups (CFL modals) ─────────────────────────────────────
router.get("/next-docnum", inventoryController.getNextDocNum);
router.get("/lookup/vendors", inventoryController.lookupVendors);
router.get("/lookup/warehouses", inventoryController.lookupWarehouses);
router.get("/lookup/accounts", inventoryController.lookupAccounts);
router.get("/lookup/business-segments", inventoryController.lookupBusinessSegments);
router.get("/lookup/cost-centers", inventoryController.lookupCostCenters);
router.get("/lookup/branches", inventoryController.lookupBranches);
router.get("/lookup/batches", inventoryController.lookupBatches);
router.get("/lookup/serials", inventoryController.lookupSerials);

module.exports = router;
