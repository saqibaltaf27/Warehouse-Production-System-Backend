const jwt = require("jsonwebtoken");
const inventoryModel = require("./inventory.model");
const { sendSuccess, sendError } = require("../../utils/response.helper");
const { logActivity } = require("../../utils/activityLogger");
const { poolPromise } = require("../../database/connection");

class InventoryController {
    static async getInventoryFilters(req, res) {
        try {
            const company = req.query.company || null;
            const filters = await inventoryModel.getInventoryFilters(company);
            sendSuccess(res, filters, "Filters fetched successfully");
        } catch (err) {
            sendError(res, "Filters not fetched successfully", err.statusCode || 500);
        }
    }

    static async getInventoryDashboardCards(req, res) {
        try {
            const sanitize = (val) => (val && val !== 'ALL' ? val : null);
            const filters = {
                company: sanitize(req.query.company),
                group: sanitize(req.query.group),
                category: sanitize(req.query.category),
                warehouse: sanitize(req.query.warehouse),
                fiscalYear: sanitize(req.query.fiscalYear)
            };
            const items = await inventoryModel.getInventoryDashboardCards(filters);
            sendSuccess(res, items, "Dashboard cards fetched successfully");
        } catch (err) {
            sendError(res, "Dashboard cards not fetched successfully", err.statusCode || 500);
        }
    }

    static async getInventoryDashboardItems(req, res) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const rawLimit = req.query.limit;
            const limit = (rawLimit === '0' || rawLimit === 'all' || rawLimit === 'ALL')
                ? 0 
                : (parseInt(rawLimit, 10) || 10);
            const offset = limit > 0 ? (page - 1) * limit : 0;

            const sanitize = (val) => (val && val !== 'ALL' && val !== 'all' ? val : null);
            const sortColumns = ['ItemCode', 'ItemName', 'Category', 'StockQty', 'ExpiryDate', 'DaysToExpiry', 'BatchNumber', 'Company'];
            const sortBy = sortColumns.includes(req.query.sortBy) ? req.query.sortBy : 'ExpiryDate';
            const sortOrder = (req.query.sortOrder && req.query.sortOrder.toUpperCase() === "DESC") ? "DESC" : "ASC";

            const pagination = { limit, offset, page };
            const sorting = { sortBy, sortOrder };
            const filters = {
                company: sanitize(req.query.company),
                group: sanitize(req.query.group),
                category: sanitize(req.query.category),
                warehouse: sanitize(req.query.warehouse),
                fiscalYear: sanitize(req.query.fiscalYear),
                search: req.query.search ? req.query.search.trim() : null,
                agingBucket: sanitize(req.query.agingBucket)
            };

            const items = await inventoryModel.getInventoryDashboardItems(pagination, sorting, filters);
            sendSuccess(res, items, "Items fetched successfully");
        } catch (err) {
            console.error("getInventoryDashboardItems error:", err);
            sendError(res, "Items not fetched successfully", err.statusCode || 500);
        }
    }


    static async getInventoryItems(req, res) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const limit = parseInt(req.query.limit, 10) || 10;
            const offset = (page - 1) * limit;

            const sortColumns = ['ItemCode', 'ItemName', 'FrgnName', 'Category', 'Stock', 'Price', 'CreateDate'];
            const sortBy = sortColumns.includes(req.query.sortBy) ? req.query.sortBy : 'Stock';
            const sortOrder = (req.query.sortOrder && req.query.sortOrder.toUpperCase() === "ASC") ? "ASC" : "DESC";

            const pagination = { limit, offset };
            const sorting = { sortBy, sortOrder };
            const sanitize = (val) => (val && val !== 'ALL' ? val : null);

            const filters = {
                company: sanitize(req.query.company),
                group: sanitize(req.query.group),
                category: sanitize(req.query.category),
                warehouse: sanitize(req.query.warehouse),
                fiscalYear: sanitize(req.query.fiscalYear),
                hideZeroQty: req.query.hideZeroQty === 'true'
            };
            const search = sanitize(req.query.search);

            const items = await inventoryModel.getInventoryItems(pagination, sorting, filters, search);
            sendSuccess(res, items, "Item Master fetched successfully");
        } catch (err) {
            sendError(res, "Item Master not fetched successfully", err.statusCode || 500);
        }
    }

    static async getItemDetails(req, res) {
        try {
            const itemCode = req.params.itemCode;
            const company = req.query.company || 'GMS';

            if (!itemCode) {
                return sendError(res, "ItemCode is required", 400);
            }

            const [warehouses, expiryLots] = await Promise.all([
                inventoryModel.getItemWarehouses(itemCode, company),
                inventoryModel.getItemExpiryLots(itemCode, company)
            ]);

            // Get metadata and history (fastest way for now without splitting metadata from history)
            // But we pass an impossible date range so we only get metadata (history array will be empty)
            const meta = await inventoryModel.getItemHistory(itemCode, company, { startDate: '1900-01-01', endDate: '1900-01-01' });
            
            const details = {
                ...meta,
                warehouses,
                expiryLots
            };

            sendSuccess(res, details, "Item details fetched successfully");
        } catch (err) {
            console.error('Error fetching item details:', err);
            sendError(res, "Item details not fetched successfully", err.statusCode || 500);
        }
    }

    static async getItemHistory(req, res) {
        try {
            const itemCode = req.params.itemCode;
            const company = req.query.company || 'GMS';
            const startDate = req.query.startDate;
            const endDate = req.query.endDate;

            if (!itemCode) {
                return sendError(res, "ItemCode is required", 400);
            }

            const filters = {};
            if (startDate && endDate) {
                filters.startDate = startDate;
                filters.endDate = endDate;
            }

            const historyData = await inventoryModel.getItemHistory(itemCode, company, filters);
            sendSuccess(res, historyData, "Item history fetched successfully");
        } catch (err) {
            console.error('Error fetching item history:', err);
            sendError(res, "Item history not fetched successfully", err.statusCode || 500);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // GOODS RECEIPT
    // ═══════════════════════════════════════════════════════════

    static async createGoodsReceipt(req, res) {
        let payload = null;
        try {
            const { company, docDate, postingDate, lines, remarks, journalRemark, branchId } = req.body;

            // Validation
            if (!company || !['GMS', 'LDS'].includes(company)) {
                return sendError(res, "Company must be 'GMS' or 'LDS'", 400);
            }
            if (!docDate) {
                return sendError(res, "DocDate is required", 400);
            }
            if (!lines || !Array.isArray(lines) || lines.length === 0) {
                return sendError(res, "At least one line item is required", 400);
            }

            const todayDate = new Date().toISOString().split('T')[0];

            payload = {
                CompanyDB: company === 'GMS' ? 'Z_Dummy_GMS_Live' : 'Z_Dummy_LDS_Live',
                DocDate: docDate,
                Comments: remarks || '',
                JournalRemark: journalRemark || remarks || (company === 'GMS' ? 'GMS Goods Receipt' : 'LDS Goods Receipt'),
                Lines: []
            };

            if (company === 'LDS') {
                payload.BranchId = parseInt(branchId, 10) || 1;
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line.itemCode || !line.quantity || line.quantity <= 0 || !line.whsCode) {
                    return sendError(res, `Line ${i + 1}: ItemCode, Quantity (>0), and WhsCode are required`, 400);
                }

                const linePayload = {
                    ItemCode: line.itemCode,
                    Quantity: parseInt(line.quantity, 10),
                    WarehouseCode: line.whsCode,
                    AccountCode: line.accountCode || '',
                    BusinessSegment: line.businessSegment || '',
                    BudgetCode: line.costCenter || ''
                };

                if (company === 'LDS') {
                    linePayload.Price = parseFloat(line.unitPrice || line.price || 0);
                }

                if (line.batches && line.batches.length > 0) {
                    linePayload.Batches = line.batches.map(b => ({
                        BatchNumber: String(b.BatchNumber || b.batchNumber || b.BatchNum || ''),
                        Quantity: parseInt(b.Quantity || b.quantity, 10),
                        AdmissionDate: b.AdmissionDate || b.admissionDate || docDate || todayDate
                    }));
                } else if (line.serials && line.serials.length > 0) {
                    linePayload.Serials = line.serials.map(s => ({
                        SerialNumber: String(s.SerialNumber || s.serialNumber || s.SysSerial || ''),
                        ManufacturerSerialNumber: String(s.ManufacturerSerialNumber || s.manufacturerSerialNumber || s.ManufSN || s.MfrSerialNo || ''),
                        AdmissionDate: s.AdmissionDate || s.admissionDate || docDate || todayDate
                    }));
                }

                payload.Lines.push(linePayload);
            }

            const sapResponse = await fetch('http://115.186.130.76:7206/api/GoodsReceipt/Create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const responseText = await sapResponse.text();
            let result;
            try {
                result = JSON.parse(responseText);
            } catch(e) {
                throw new Error("Invalid JSON response from SAP Pipeline: " + responseText);
            }

            if (!sapResponse.ok) {
                throw new Error(result.message || result.error || JSON.stringify(result));
            }

            const standardizedResult = {
                ...result,
                docEntry: result.DocEntry,
                docNum: result.DocNum || result.DocEntry
            };

            // ── Audit Log ───────────────────────────────────────────
            await logActivity({
                req,
                company,
                moduleName: 'INVENTORY',
                actionType: 'CREATE',
                docType: 'GOODS_RECEIPT',
                docNum: standardizedResult.docNum,
                docEntry: standardizedResult.docEntry,
                description: `Created Goods Receipt with ${lines.length} lines. ${remarks || ''}`.trim()
            });

            sendSuccess(res, standardizedResult, "Goods Receipt created successfully via SAP Pipeline", 201);
        } catch (err) {
            console.error("Goods Receipt Error:", err);
            if (payload) {
                console.error("Failed Payload:", JSON.stringify(payload, null, 2));
            }
            sendError(res, err.message || "Failed to create Goods Receipt", err.statusCode || 500);
        }
    }

    static async getGoodsReceipts(req, res) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const limit = parseInt(req.query.limit, 10) || 20;
            const offset = (page - 1) * limit;

            const sortColumns = ['DocEntry', 'DocNum', 'DocDate', 'PostingDate', 'DocTotal', 'CreatedAt', 'CardName'];
            const sortBy = sortColumns.includes(req.query.sortBy) ? req.query.sortBy : 'CreatedAt';
            const sortOrder = (req.query.sortOrder && req.query.sortOrder.toUpperCase() === "ASC") ? "ASC" : "DESC";

            const pagination = { limit, offset };
            const sorting = { sortBy, sortOrder };
            const filters = {
                company: req.query.company || null,
                status: req.query.status || null,
                search: req.query.search || null
            };

            const result = await inventoryModel.getGoodsReceipts(pagination, sorting, filters);
            sendSuccess(res, result, "Goods Receipts fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch Goods Receipts", err.statusCode || 500);
        }
    }

    static async getGoodsReceiptById(req, res) {
        try {
            const docEntry = parseInt(req.params.docEntry, 10);
            const company = req.query.company || null;
            if (!docEntry) return sendError(res, "DocEntry is required", 400);

            const result = await inventoryModel.getGoodsReceiptById(docEntry, company);
            if (!result) return sendError(res, "Goods Receipt not found", 404);

            sendSuccess(res, result, "Goods Receipt fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch Goods Receipt", err.statusCode || 500);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // GOODS ISSUE
    // ═══════════════════════════════════════════════════════════

    static async createGoodsIssue(req, res) {
        let payload = null;
        try {
            const { company, docDate, postingDate, lines, remarks, branchId } = req.body;

            if (!company || !['GMS', 'LDS'].includes(company)) {
                return sendError(res, "Company must be 'GMS' or 'LDS'", 400);
            }
            if (!docDate) {
                return sendError(res, "DocDate is required", 400);
            }
            if (!lines || !Array.isArray(lines) || lines.length === 0) {
                return sendError(res, "At least one line item is required", 400);
            }

            payload = {
                CompanyDB: company === 'GMS' ? 'Z_Dummy_GMS_Live' : 'Z_Dummy_LDS_Live',
                DocDate: docDate,
                Comments: remarks || '',
                Lines: []
            };

            if (company === 'LDS') {
                if (!branchId) return sendError(res, "BranchId is required for LDS", 400);
                payload.BranchId = parseInt(branchId, 10);
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line.itemCode || !line.quantity || line.quantity <= 0 || !line.whsCode) {
                    return sendError(res, `Line ${i + 1}: ItemCode, Quantity, and WhsCode are required`, 400);
                }

                const linePayload = {
                    ItemCode: line.itemCode,
                    Quantity: parseInt(line.quantity, 10),
                    WarehouseCode: line.whsCode,
                    AccountCode: line.accountCode || '',
                    BudgetCode: line.costCenter || '',
                    BusinessSegment: line.businessSegment || ''
                };

                if (line.batches && line.batches.length > 0) {
                    linePayload.Batches = line.batches.map(b => ({
                        BatchNumber: String(b.BatchNum || b.BatchNumber || b.batchNumber),
                        Quantity: parseInt(b.Quantity || b.quantity, 10)
                    }));
                } else if (line.serials && line.serials.length > 0) {
                    linePayload.Serials = line.serials.map(s => ({
                        SerialNumber: String(s.SysSerial || s.SerialNumber || s.serialNumber)
                    }));
                }

                payload.Lines.push(linePayload);
            }

            const sapResponse = await fetch('http://115.186.130.76:7206/api/goodsissue/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const responseText = await sapResponse.text();
            let result;
            try {
                result = JSON.parse(responseText);
            } catch(e) {
                throw new Error("Invalid JSON response from SAP Pipeline: " + responseText);
            }

            if (!sapResponse.ok) {
                throw new Error(result.message || result.error || JSON.stringify(result));
            }

            const standardizedResult = {
                ...result,
                docEntry: result.DocEntry,
                docNum: result.DocNum || result.DocEntry
            };

            // ── Audit Log ───────────────────────────────────────────
            await logActivity({
                req,
                company,
                moduleName: 'INVENTORY',
                actionType: 'CREATE',
                docType: 'GOODS_ISSUE',
                docNum: standardizedResult.docNum,
                docEntry: standardizedResult.docEntry,
                description: `Created Goods Issue with ${lines.length} lines. ${remarks || ''}`.trim()
            });

            sendSuccess(res, standardizedResult, "Goods Issue created successfully via SAP Pipeline", 201);
        } catch (err) {
            console.error("Goods Issue Error:", err);
            if (payload) {
                console.error("Failed Payload:", JSON.stringify(payload, null, 2));
            }
            sendError(res, err.message || "Failed to create Goods Issue", err.statusCode || 500);
        }
    }

    static async getGoodsIssues(req, res) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const limit = parseInt(req.query.limit, 10) || 20;
            const offset = (page - 1) * limit;

            const sortColumns = ['DocEntry', 'DocNum', 'DocDate', 'PostingDate', 'DocTotal', 'CreatedAt'];
            const sortBy = sortColumns.includes(req.query.sortBy) ? req.query.sortBy : 'CreatedAt';
            const sortOrder = (req.query.sortOrder && req.query.sortOrder.toUpperCase() === "ASC") ? "ASC" : "DESC";

            const pagination = { limit, offset };
            const sorting = { sortBy, sortOrder };
            const filters = {
                company: req.query.company || null,
                status: req.query.status || null,
                search: req.query.search || null
            };

            const result = await inventoryModel.getGoodsIssues(pagination, sorting, filters);
            sendSuccess(res, result, "Goods Issues fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch Goods Issues", err.statusCode || 500);
        }
    }

    static async getGoodsIssueById(req, res) {
        try {
            const docEntry = parseInt(req.params.docEntry, 10);
            const company = req.query.company || null;
            if (!docEntry) return sendError(res, "DocEntry is required", 400);

            const result = await inventoryModel.getGoodsIssueById(docEntry, company);
            if (!result) return sendError(res, "Goods Issue not found", 404);

            sendSuccess(res, result, "Goods Issue fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch Goods Issue", err.statusCode || 500);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // INVENTORY TRANSFER
    // ═══════════════════════════════════════════════════════════

    static async createInventoryTransfer(req, res) {
        try {
            if (!req.body.company || !req.body.fromWhs || !req.body.toWhs || !req.body.lines || req.body.lines.length === 0) {
                return sendError(res, "Company, From Warehouse, To Warehouse, and Lines are required", 400);
            }

            for (let i = 0; i < req.body.lines.length; i++) {
                const line = req.body.lines[i];
                if (!line.itemCode || !line.quantity || line.quantity <= 0) {
                    return sendError(res, `Line ${i + 1}: ItemCode and Quantity (>0) are required`, 400);
                }
            }

            const userId = req.user?.empId || 0;
            const result = await inventoryModel.createInventoryTransfer(req.body, userId);

            // ── Audit Log ───────────────────────────────────────────
            await logActivity({
                req,
                company: req.body.company,
                moduleName: 'INVENTORY',
                actionType: 'CREATE',
                docType: 'INVENTORY_TRANSFER',
                docNum: result?.DocNum || result?.docNum || null,
                docEntry: result?.DocEntry || result?.docEntry || null,
                description: `Created Inventory Transfer from WH ${req.body.fromWhs} to WH ${req.body.toWhs} (${req.body.lines?.length || 0} lines)`
            });

            sendSuccess(res, result, "Inventory Transfer created successfully", 201);
        } catch (err) {
            sendError(res, err.message || "Failed to create Inventory Transfer", err.statusCode || 500);
        }
    }

    static async getInventoryTransfers(req, res) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const limit = parseInt(req.query.limit, 10) || 20;
            const offset = (page - 1) * limit;

            const sortColumns = ['DocEntry', 'DocNum', 'DocDate', 'TaxDate'];
            const sortBy = sortColumns.includes(req.query.sortBy) ? req.query.sortBy : 'DocEntry';
            const sortOrder = (req.query.sortOrder && req.query.sortOrder.toUpperCase() === "ASC") ? "ASC" : "DESC";

            const pagination = { limit, offset };
            const sorting = { sortBy, sortOrder };
            const filters = {
                company: req.query.company || null,
                search: req.query.search || null
            };

            const result = await inventoryModel.getInventoryTransfers(pagination, sorting, filters);
            sendSuccess(res, result, "Inventory Transfers fetched successfully");
        } catch (err) {
            console.error("Transfers error: ", err);
            sendError(res, "Failed to fetch Inventory Transfers", err.statusCode || 500);
        }
    }

    static async getInventoryTransferById(req, res) {
        try {
            const docEntry = parseInt(req.params.docEntry, 10);
            const company = req.query.company || null;
            if (!docEntry) return sendError(res, "DocEntry is required", 400);

            const result = await inventoryModel.getInventoryTransferById(docEntry, company);
            if (!result) return sendError(res, "Inventory Transfer not found", 404);

            sendSuccess(res, result, "Inventory Transfer fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch Inventory Transfer", err.statusCode || 500);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // DELIVERY CHALLAN
    // ═══════════════════════════════════════════════════════════

    static async getDeliveryChallans(req, res) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const limit = parseInt(req.query.limit, 10) || 20;
            const offset = (page - 1) * limit;

            const sortColumns = ['DocEntry', 'DocNum', 'DocDate', 'CreatedAt', 'CardName'];
            const sortBy = sortColumns.includes(req.query.sortBy) ? req.query.sortBy : 'DocEntry';
            const sortOrder = (req.query.sortOrder && req.query.sortOrder.toUpperCase() === "ASC") ? "ASC" : "DESC";

            const pagination = { limit, offset };
            const sorting = { sortBy, sortOrder };
            const filters = {
                company: req.query.company || null,
                search: req.query.search || null
            };

            const result = await inventoryModel.getDeliveryChallans(pagination, sorting, filters);
            sendSuccess(res, result, "Delivery Challans fetched successfully");
        } catch (err) {
            console.error("Delivery Challans error: ", err);
            sendError(res, "Failed to fetch Delivery Challans", err.statusCode || 500);
        }
    }

    static async getDeliveryChallanById(req, res) {
        try {
            const docEntry = parseInt(req.params.docEntry, 10);
            const company = req.query.company || null;
            if (!docEntry) return sendError(res, "DocEntry is required", 400);

            const result = await inventoryModel.getDeliveryChallanById(docEntry, company);
            if (!result) return sendError(res, "Delivery Challan not found", 404);

            sendSuccess(res, result, "Delivery Challan fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch Delivery Challan details", err.statusCode || 500);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // INCIDENT REPORTING
    // ═══════════════════════════════════════════════════════════

    static async getIncidentReports(req, res) {
        try {
            const result = await inventoryModel.getIncidentReports();
            sendSuccess(res, result, "Incident reports fetched successfully");
        } catch (err) {
            console.error("Incident reports error:", err);
            sendError(res, "Failed to fetch incident reports", err.statusCode || 500);
        }
    }

    static async createIncidentReport(req, res) {
        try {
            const data = req.body;
            const result = await inventoryModel.createIncidentReport(data);

            // ── Audit Log ───────────────────────────────────────────
            await logActivity({
                req,
                moduleName: 'INVENTORY',
                actionType: 'CREATE',
                docType: 'INCIDENT_REPORT',
                docEntry: result?.id || null,
                description: `Created Incident Report: ${data.IncidentType || ''} at ${data.Location || ''}`.trim()
            });

            sendSuccess(res, { id: result.id }, "Incident report created successfully", 201);
        } catch (err) {
            console.error("Create incident report error:", err);
            sendError(res, "Failed to create incident report", err.statusCode || 500);
        }
    }

    static async getUserInfo(req, res) {
        try {
            const empId = req.query.empId;
            if (!empId) return sendError(res, "empId is required", 400);

            const result = await inventoryModel.getUserInfo(empId);
            sendSuccess(res, result, "User info fetched successfully");
        } catch (err) {
            console.error("User info error:", err);
            sendError(res, "Failed to fetch user info", err.statusCode || 500);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // TRAINING CALENDAR
    // ═══════════════════════════════════════════════════════════

    static async getTrainings(req, res) {
        try {
            const result = await inventoryModel.getTrainings();
            sendSuccess(res, result, "Trainings fetched successfully");
        } catch (err) {
            console.error("Trainings error:", err);
            sendError(res, "Failed to fetch trainings", err.statusCode || 500);
        }
    }

    static async createTraining(req, res) {
        try {
            const data = req.body;
            const result = await inventoryModel.createTraining(data);

            // ── Audit Log ───────────────────────────────────────────
            await logActivity({
                req,
                moduleName: 'INVENTORY',
                actionType: 'CREATE',
                docType: 'TRAINING',
                docEntry: result?.id || null,
                description: `Created Training session: ${data.Title || ''} (${data.Category || ''})`.trim()
            });

            sendSuccess(res, { id: result.id }, "Training session created successfully", 201);
        } catch (err) {
            console.error("Create training error:", err);
            sendError(res, "Failed to create training session", err.statusCode || 500);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // LOOKUPS — For CFL modals
    static async lookupItems(req, res) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const limit = parseInt(req.query.limit, 10) || 50;
            const offset = (page - 1) * limit;

            const result = await inventoryModel.lookupItems(
                req.query.company || null,
                req.query.search || null,
                { limit, offset }
            );
            sendSuccess(res, result, "Items fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch items", err.statusCode || 500);
        }
    }

    static async lookupVendors(req, res) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const limit = parseInt(req.query.limit, 10) || 20;
            const offset = (page - 1) * limit;

            const result = await inventoryModel.lookupVendors(
                req.query.company || null,
                req.query.search || null,
                { limit, offset }
            );
            sendSuccess(res, result, "Vendors fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch vendors", err.statusCode || 500);
        }
    }

    static async lookupWarehouses(req, res) {
        try {
            const result = await inventoryModel.lookupWarehouses(
                req.query.company || null,
                req.query.search || null
            );
            sendSuccess(res, result, "Warehouses fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch warehouses", err.statusCode || 500);
        }
    }

    static async lookupAccounts(req, res) {
        try {
            const result = await inventoryModel.lookupAccounts(
                req.query.company || null,
                req.query.search || null
            );
            sendSuccess(res, result, "Accounts fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch accounts", err.statusCode || 500);
        }
    }

    static async lookupBranches(req, res) {
        try {
            const result = await inventoryModel.lookupBranches();
            sendSuccess(res, result, "Branches fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch branches", err.statusCode || 500);
        }
    }

    static async lookupBusinessSegments(req, res) {
        try {
            const result = await inventoryModel.lookupBusinessSegments(
                req.query.company || null
            );
            sendSuccess(res, result, "Business segments fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch business segments", err.statusCode || 500);
        }
    }

    static async lookupCostCenters(req, res) {
        try {
            const result = await inventoryModel.lookupCostCenters(
                req.query.company || null
            );
            sendSuccess(res, result, "Cost centers fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch cost centers", err.statusCode || 500);
        }
    }

    static async getNextDocNum(req, res) {
        try {
            const type = req.query.type || 'goods-receipt';
            const company = req.query.company || 'GMS';
            const nextDocNum = await inventoryModel.getNextDocNum(type, company);
            sendSuccess(res, { nextDocNum }, "Next DocNum fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch next DocNum", err.statusCode || 500);
        }
    }
    static async lookupBatches(req, res) {
        try {
            const company = req.query.company || null;
            const itemCode = req.query.itemCode;
            const whsCode = req.query.whsCode;

            if (!itemCode) {
                return sendError(res, "ItemCode is required", 400);
            }

            const result = await inventoryModel.lookupBatches(company, itemCode, whsCode);
            sendSuccess(res, result, "Batches fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch batches", err.statusCode || 500);
        }
    }

    static async lookupSerials(req, res) {
        try {
            const company = req.query.company || null;
            const itemCode = req.query.itemCode;
            const whsCode = req.query.whsCode;

            if (!itemCode) {
                return sendError(res, "ItemCode is required", 400);
            }

            const result = await inventoryModel.lookupSerials(company, itemCode, whsCode);
            sendSuccess(res, result, "Serials fetched successfully");
        } catch (err) {
            console.error("lookupSerials error:", err);
            sendError(res, err.message || "Failed to fetch serials", err.statusCode || 500);
        }
    }
}

module.exports = InventoryController;