const router = require("express").Router();
const authMiddleware = require('../../middleware/auth.middleware');
const complaintsController = require("../../controller/Complaints/complaints.controller");


// ── Lookups ─────────────────────────────────────
router.get("/lookup/items", authMiddleware, complaintsController.lookupItems);

// ── Complaints ──────────────────────────────────
router.post("/", authMiddleware, complaintsController.createComplaint);
router.get("/", authMiddleware, complaintsController.getAllComplaints);
router.put("/:complaintNumber", authMiddleware, complaintsController.updateComplaint);

// ── COA ─────────────────────────────────────────
router.get("/coa/product-details/:itemCode", authMiddleware, complaintsController.getCOAProductDetails);

module.exports = router;
