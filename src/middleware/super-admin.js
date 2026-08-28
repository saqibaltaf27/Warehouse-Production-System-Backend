// Define super admin employee IDs here
// You can add more IDs to this array in the future
const SUPER_ADMIN_IDS = ['2142', '1949'];

const isSuperAdmin = (req, res, next) => {
    // Check if the authenticated user's empId is in the list of super admins
    const empId = req.user?.empId;

    if (empId && SUPER_ADMIN_IDS.includes(empId.toString())) {
        next(); // User is a super admin, proceed to the route
    } else {
        return res.status(403).json({
            success: false,
            message: "Access Denied: Super Admin privileges required."
        });
    }
};

module.exports = {
    isSuperAdmin,
    SUPER_ADMIN_IDS
};
