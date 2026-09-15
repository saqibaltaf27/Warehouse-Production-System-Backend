const express = require('express');
const router = express.Router();
const { getMachines } = require('../../controller/Machine/machine.controller');

router.get('/', getMachines);

module.exports = router;
