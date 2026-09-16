const PurchaseOrderModel = require("./PurchaseOrder.model");
const { sendSuccess, sendError } = require("../../utils/response.helper");
const axios = require("axios");

const PURCHASE_REQUEST_API =
  "http://115.186.130.76:7206/api/PurchaseRequest/Create";
class PurchaseOrderController {
  static async getPurchaseRequests(req, res) {
    try {
      const page = parseInt(req.query.page, 10) || 1;
      const rawLimit = req.query.limit;
      const search = req.query.search || "";
      const limit =
        rawLimit === "0" || rawLimit === "all" || rawLimit === "ALL"
          ? 0
          : parseInt(rawLimit, 10) || 10;
      const offset = limit > 0 ? (page - 1) * limit : 0;

      const result = await PurchaseOrderModel.getPurchaseRequests(
        limit,
        offset,
        search,
      );

      const responseData = {
        data: result.data,
        pagination: {
          total: result.total,
          page: page,
          limit: limit,
          totalPages: limit > 0 ? Math.ceil(result.total / limit) : 1,
        },
      };

      sendSuccess(res, responseData, "Purchase requests fetched successfully");
    } catch (err) {
      sendError(
        res,
        "Purchase requests not fetched successfully",
        err.statusCode || 500,
      );
    }
  }

  static async getPurchaseRequestDetails(req, res) {
    try {
      const docEntry = parseInt(req.params.docEntry, 10);
      if (!docEntry) {
        return sendError(res, "Invalid document entry", 400);
      }
      const result =
        await PurchaseOrderModel.getPurchaseRequestDetails(docEntry);
      if (!result.header) {
        return sendError(res, "Purchase request not found", 404);
      }
      sendSuccess(res, result, "Purchase request details fetched successfully");
    } catch (err) {
      sendError(
        res,
        "Failed to fetch purchase request details",
        err.statusCode || 500,
      );
    }
  }

  static async createPurchaseRequest(req, res) {
    try {
      const {
        company,
        docDate,
        requiredDate,
        validUntil,
        branchId,
        remarks,
        lines,
      } = req.body;

      if (!docDate || !requiredDate || !lines || lines.length === 0) {
        return sendError(
          res,
          "DocDate, RequiredDate, and at least one line item are required",
          400,
        );
      }

      // Fetch UoM codes for all item codes from the database
      const { sql, poolPromise } = require("../../database/connection");
      const pool = await poolPromise;
      const itemCodes = lines.map((l) => l.itemCode).filter(Boolean);
      const uomMap = {};

      if (itemCodes.length > 0) {
        const request = pool.request();
        const placeholders = itemCodes
          .map((code, i) => {
            request.input(`item${i}`, sql.VarChar, code);
            return `@item${i}`;
          })
          .join(",");

        const uomResult = await request.query(
          `SELECT ItemCode, InvntryUom FROM LDS_LIVE.dbo.OITM WHERE ItemCode IN (${placeholders})`,
        );

        for (const row of uomResult.recordset) {
          uomMap[row.ItemCode] = row.InvntryUom || null;
        }
      }

      const payload = {
        CompanyDB: "Z_Dummy_LDS_Live",
        DocDate: docDate,
        RequiredDate: requiredDate,
        ValidUntil: validUntil || requiredDate,
        RequesterCode: "admin",
        Department: 4,
        BranchId: parseInt(branchId, 10) || 1,
        SendEmailNotification: false,
        Remarks: remarks || "",
        Lines: lines.map((line) => ({
          ItemCode: line.itemCode,
          Quantity: parseInt(line.quantity, 10) || 1,
          RequiredDate: requiredDate,
          WarehouseCode: line.warehouseCode || "",
          BusinessSegment: line.businessSegment || "",
          Reason: line.reason || "",
          UoMCode: uomMap[line.itemCode] || "Manual",
        })),
      };

      console.log(
        "Sending Purchase Request to external API:",
        JSON.stringify(payload, null, 2),
      );

      const response = await axios.post(PURCHASE_REQUEST_API, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      });

      console.log("External API response:", response.status, response.data);
      sendSuccess(res, response.data, "Purchase request created successfully");
    } catch (err) {
      console.error(
        "Purchase Request creation failed:",
        err.response?.data || err.message,
      );
      const message =
        err.response?.data?.message ||
        err.response?.data?.Message ||
        err.message ||
        "Failed to create purchase request";
      sendError(res, message, err.response?.status || 500);
    }
  }
}

module.exports = PurchaseOrderController;
