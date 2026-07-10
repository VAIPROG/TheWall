//! Pagination helpers for V3 routes.

/// Normalised page parameters.
#[derive(Debug, Clone, Copy)]
pub struct PageParams {
    pub page: i64,
    pub per_page: i64,
    pub offset: i64,
}

impl PageParams {
    /// Build page params, clamping values to sane bounds.
    pub fn new(page: Option<i64>, per_page: Option<i64>, default_per_page: i64, max_per_page: i64) -> Self {
        let page = page.unwrap_or(1).max(1);
        let per_page = per_page
            .unwrap_or(default_per_page)
            .clamp(1, max_per_page);
        let offset = (page - 1) * per_page;
        Self { page, per_page, offset }
    }

    /// Compute total pages from a total item count.
    pub fn total_pages(&self, total: i64) -> i64 {
        if self.per_page <= 0 {
            0
        } else {
            (total + self.per_page - 1) / self.per_page
        }
    }
}
