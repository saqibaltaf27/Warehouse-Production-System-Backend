/**
 * response.helper.js — Standardized API Responses
 * 
 * This makes frontend code messy — you never know which format to expect.
 * With helpers, EVERY response follows the same shape:
 * 
 *   {
 *     success: true/false,
 *     message: "Human readable message",
 *     data: { ... },                        // For single/list responses
 *     meta: { page, limit, total, pages }   // For paginated responses
 *   }
 * 
 * Frontend can always do: if (res.data.success) { use(res.data.data) }
 */

/**
 * Success response
 */
function sendSuccess(res, data = null, message = "Success", statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

/**
 * Paginated success response
 * Includes meta info so frontend can render pagination controls
 * 
 * @param {object} res - Express response
 * @param {Array} data - The rows for the current page
 * @param {number} total - Total rows matching the query (before pagination)
 * @param {number} page - Current page number
 * @param {number} limit - Items per page
 */
function sendPaginated(res, data, total, page, limit) {
  return res.status(200).json({
    success: true,
    data,
    meta: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
}

/**
 * Error response
 */
function sendError(res, message = "Something went wrong", statusCode = 500, errors = null) {
  return res.status(statusCode).json({
    success: false,
    message,
    ...(errors && { errors }),
  });
}

module.exports = { sendSuccess, sendPaginated, sendError };
