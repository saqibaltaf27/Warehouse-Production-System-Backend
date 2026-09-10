const PurchaseOrderModel = require("./PurchaseOrder.model");
const { sendSuccess, sendError } = require("../../utils/response.helper");

class PurchaseOrderController {
    static async getPurchaseRequests(req, res) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const rawLimit = req.query.limit;
            const search = req.query.search || '';
            const limit = (rawLimit === '0' || rawLimit === 'all' || rawLimit === 'ALL')
                ? 0 
                : (parseInt(rawLimit, 10) || 10);
            const offset = limit > 0 ? (page - 1) * limit : 0;

            const result = await PurchaseOrderModel.getPurchaseRequests(limit, offset, search);
            
            const responseData = {
                data: result.data,
                pagination: {
                    total: result.total,
                    page: page,
                    limit: limit,
                    totalPages: limit > 0 ? Math.ceil(result.total / limit) : 1
                }
            };

            sendSuccess(res, responseData, "Purchase requests fetched successfully");
        } catch (err) {
            sendError(res, "Purchase requests not fetched successfully", err.statusCode || 500);
        }
    }

    static async getPurchaseRequestDetails(req, res) {
        try {
            const docEntry = parseInt(req.params.docEntry, 10);
            if (!docEntry) {
                return sendError(res, "Invalid document entry", 400);
            }
            const result = await PurchaseOrderModel.getPurchaseRequestDetails(docEntry);
            if (!result.header) {
                return sendError(res, "Purchase request not found", 404);
            }
            sendSuccess(res, result, "Purchase request details fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch purchase request details", err.statusCode || 500);
        }
    }
}

module.exports = PurchaseOrderController;
