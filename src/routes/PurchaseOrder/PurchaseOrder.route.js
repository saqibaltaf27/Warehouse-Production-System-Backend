const express = require("express");
const PurchaseOrderController = require("../../controller/PurchaseOrder/PurchaseOrder.controller");
const authenticateToken = require("../../middleware/auth.middleware");
const router = express.Router();

router.get("/requests", authenticateToken, PurchaseOrderController.getPurchaseRequests);
router.get("/requests/:docEntry", authenticateToken, PurchaseOrderController.getPurchaseRequestDetails);

module.exports = router;
