const { sql, poolPromise } = require("../database/connection");
const logger = console;
const jwt = require("jsonwebtoken");

/**
 * Safely extracts empId and ipAddress from the Express request object if available
 */
function extractClientInfo(req) {
  let empId = null;
  let ipAddress = null;

  if (req) {
    // 1. Check req.user (attached by auth.middleware.js)
    if (req.user && (req.user.empId || req.user.userId || req.user.id)) {
      empId = req.user.empId || req.user.userId || req.user.id;
    } else {
      // 2. Fallback: decode JWT Bearer token from header
      try {
        const authHeader = req.headers?.authorization;
        const token = (authHeader && authHeader.split(" ")[1]) || req.query?.token;
        if (token) {
          const decoded = jwt.decode(token);
          if (decoded && (decoded.empId || decoded.userId || decoded.id)) {
            empId = decoded.empId || decoded.userId || decoded.id;
          }
        }
      } catch (e) {
        // ignore decode failure
      }
    }

    // 3. Extract client IP
    ipAddress = req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || req.ip || null;
    if (ipAddress && typeof ipAddress === "string") {
      ipAddress = ipAddress.split(",")[0].trim().replace("::ffff:", "");
    }
  }

  return { empId, ipAddress };
}

/**
 * Logs an action to the Warehouse.dbo.logs table.
 * 
 * @param {Object} params
 * @param {number|string} [params.empId] - Employee ID (optional if req is provided)
 * @param {string} [params.company] - Company identifier ('GMS', 'LDS', etc.)
 * @param {string} params.moduleName - Module name ('INVENTORY', 'RECEIVING', 'DISPATCH', 'AUTH', 'ORDERS')
 * @param {string} [params.actionType='CREATE'] - Action type ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT')
 * @param {string} [params.docType] - Document type ('GOODS_ISSUE', 'GOODS_RECEIPT', 'GRN_PO', 'TRANSFER', 'DISPATCH', 'INCIDENT_REPORT', 'TRAINING')
 * @param {string|number} [params.docNum] - Visible Document Number
 * @param {number} [params.docEntry] - Internal SAP or WMS DocEntry
 * @param {string|number} [params.baseDocNum] - Upstream Reference Document (e.g. PO #, SO #)
 * @param {string} [params.description] - Human-readable remarks or notes
 * @param {string} [params.ipAddress] - Client IP Address (optional if req is provided)
 * @param {Object} [params.req] - Express request object (optional)
 */
async function logActivity({
  empId = null,
  company = null,
  moduleName,
  actionType = "CREATE",
  docType = null,
  docNum = null,
  docEntry = null,
  baseDocNum = null,
  description = null,
  ipAddress = null,
  req = null
}) {
  try {
    const extracted = extractClientInfo(req);
    const resolvedEmpId = empId || extracted.empId;
    const resolvedIp = ipAddress || extracted.ipAddress;

    if (!resolvedEmpId) {
      console.warn(`⚠️ [ActivityLogger] Log skipped for module '${moduleName}': empId is missing.`);
      return;
    }

    const pool = await poolPromise;
    const query = `
      INSERT INTO Warehouse.dbo.logs (
        emp_id, company, ip_address, module_name, action_type,
        doc_type, doc_num, doc_entry, base_doc_num, description
      )
      VALUES (
        @empId, @company, @ipAddress, @moduleName, @actionType,
        @docType, @docNum, @docEntry, @baseDocNum, @description
      )
    `;

    await pool.request()
      .input("empId", sql.Int, parseInt(resolvedEmpId, 10))
      .input("company", sql.VarChar(20), company ? String(company).substring(0, 20) : null)
      .input("ipAddress", sql.VarChar(45), resolvedIp ? String(resolvedIp).substring(0, 45) : null)
      .input("moduleName", sql.VarChar(50), String(moduleName || 'GENERAL'))
      .input("actionType", sql.VarChar(20), String(actionType || 'CREATE'))
      .input("docType", sql.VarChar(50), docType ? String(docType) : null)
      .input("docNum", sql.VarChar(50), docNum ? String(docNum) : null)
      .input("docEntry", sql.Int, docEntry ? parseInt(docEntry, 10) : null)
      .input("baseDocNum", sql.VarChar(50), baseDocNum ? String(baseDocNum) : null)
      .input("description", sql.NVarChar(sql.MAX), description ? String(description) : null)
      .query(query);

  } catch (error) {
    if (logger && logger.error) {
      logger.error("Failed to insert log into Warehouse.dbo.logs:", error);
    } else {
      console.error("⚠️ [ActivityLogger Error]:", error.message);
    }
  }
}

module.exports = { logActivity };
