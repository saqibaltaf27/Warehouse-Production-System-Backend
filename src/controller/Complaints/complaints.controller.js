const complaintsModel = require("./complaints.model");
const { sendSuccess, sendError } = require("../../utils/response.helper");

class ComplaintsController {
    static async lookupItems(req, res) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const limit = parseInt(req.query.limit, 10) || 200;
            const offset = (page - 1) * limit;

            const result = await complaintsModel.lookupItems(
                req.query.company || null,
                req.query.search || null,
                { limit, offset }
            );
            sendSuccess(res, result, "Items fetched successfully");
        } catch (err) {
            sendError(res, "Failed to fetch items", err.statusCode || 500);
        }
    }

    static async createComplaint(req, res) {
        try {
            const data = req.body;
            if (!data.Product) {
                return sendError(res, "Product is required", 400);
            }
            const result = await complaintsModel.createComplaint(data);
            sendSuccess(res, result, "Complaint created successfully");
        } catch (err) {
            console.error("Error creating complaint:", err);
            sendError(res, "Failed to create complaint", 500);
        }
    }

    static async getAllComplaints(req, res) {
        try {
            const page = parseInt(req.query.page, 10) || 1;
            const limit = parseInt(req.query.limit, 10) || 10;
            const offset = (page - 1) * limit;

            const result = await complaintsModel.getAllComplaints({ limit, offset });
            
            sendSuccess(res, result, "Complaints fetched successfully");
        } catch (err) {
            console.error("Error fetching complaints:", err);
            sendError(res, "Failed to fetch complaints", 500);
        }
    }

    static async updateComplaint(req, res) {
        try {
            const complaintNumber = req.params.complaintNumber;
            const data = req.body;
            if (!complaintNumber) {
                return sendError(res, "Complaint Number is required", 400);
            }
            
            const editedBy = req.user ? `${req.user.empId}-${req.user.fullName}` : 'System';
            const result = await complaintsModel.updateComplaint(complaintNumber, data, editedBy);
            
            sendSuccess(res, result, "Complaint updated successfully");
        } catch (err) {
            console.error("Error updating complaint:", err);
            sendError(res, "Failed to update complaint: " + err.message, 500);
        }
    }

    static async getCOAProductDetails(req, res) {
        try {
            const itemCode = req.params.itemCode;
            if (!itemCode) {
                return sendError(res, 'ItemCode is required', 400);
            }
            
            const details = await complaintsModel.getCOAProductDetails(itemCode);
            if (!details) {
                return sendError(res, 'Product details not found', 404);
            }
            
            sendSuccess(res, details, "COA product details fetched successfully");
        } catch (error) {
            console.error("Error getting COA product details:", error);
            sendError(res, 'Internal Server Error: ' + error.message, 500);
        }
    }
}

module.exports = ComplaintsController;
