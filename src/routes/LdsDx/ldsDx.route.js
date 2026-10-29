const express = require("express");
const router = express.Router();
const controller = require("../../controller/LdsDx/ldsDx.controller");
const authenticateToken = require("../../middleware/auth.middleware");

router.get("/dashboard", authenticateToken, controller.getDashboard);

module.exports = router;
