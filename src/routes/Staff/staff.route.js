const express = require('express');
const router = express.Router();
const { getStaff, addStaff, updateStaff } = require('../../controller/Staff/staff.controller');

router.get('/', getStaff);
router.post('/', addStaff);
router.put('/:id', updateStaff);

module.exports = router;
