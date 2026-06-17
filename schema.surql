-- ── Namespacing ────────────────────────────────────────────────────────────
DEFINE NAMESPACE IF NOT EXISTS dallas;
DEFINE DATABASE  IF NOT EXISTS permits;

USE NS dallas DB permits;

-- ── Nodes ───────────────────────────────────────────────────────────────────

DEFINE TABLE permit SCHEMALESS
  COMMENT 'A building/planning/enforcement/public-works record from Accela';

DEFINE INDEX permit_record_number ON permit FIELDS record_number UNIQUE;
DEFINE INDEX permit_module        ON permit FIELDS module;
DEFINE INDEX permit_status        ON permit FIELDS status;
DEFINE INDEX permit_applied_date  ON permit FIELDS applied_date;
DEFINE INDEX permit_issued_date   ON permit FIELDS issued_date;
DEFINE INDEX permit_type          ON permit FIELDS permit_type;

-- ─────────────────────────────────────────────────────────────────────────────

DEFINE TABLE contractor SCHEMALESS
  COMMENT 'A licensed contractor or professional';

DEFINE INDEX contractor_license ON contractor FIELDS license_number UNIQUE;

-- ─────────────────────────────────────────────────────────────────────────────

DEFINE TABLE address SCHEMALESS
  COMMENT 'A street address (normalised text)';

DEFINE INDEX address_text ON address FIELDS text UNIQUE;

-- ─────────────────────────────────────────────────────────────────────────────

DEFINE TABLE parcel SCHEMALESS
  COMMENT 'A property parcel identified by parcel number';

DEFINE INDEX parcel_number ON parcel FIELDS parcel_number UNIQUE;

-- ─────────────────────────────────────────────────────────────────────────────

DEFINE TABLE inspection SCHEMALESS
  COMMENT 'An inspection event attached to a permit';

-- ─────────────────────────────────────────────────────────────────────────────

DEFINE TABLE contact SCHEMALESS
  COMMENT 'A person (owner, applicant, inspector, licensed professional)';

-- ── Edges ───────────────────────────────────────────────────────────────────

-- contractor -[filed]-> permit
DEFINE TABLE filed SCHEMALESS TYPE RELATION FROM contractor TO permit;
DEFINE INDEX filed_unique ON filed FIELDS in, out UNIQUE;

-- permit -[located_at]-> address
DEFINE TABLE located_at SCHEMALESS TYPE RELATION FROM permit TO address;
DEFINE INDEX located_at_unique ON located_at FIELDS in, out UNIQUE;

-- permit -[on_parcel]-> parcel
DEFINE TABLE on_parcel SCHEMALESS TYPE RELATION FROM permit TO parcel;
DEFINE INDEX on_parcel_unique ON on_parcel FIELDS in, out UNIQUE;

-- permit -[has_inspection]-> inspection
DEFINE TABLE has_inspection SCHEMALESS TYPE RELATION FROM permit TO inspection;

-- inspection -[conducted_by]-> contact
DEFINE TABLE conducted_by SCHEMALESS TYPE RELATION FROM inspection TO contact;

-- contact -[associated_with]-> permit  (owners, applicants)
DEFINE TABLE associated_with SCHEMALESS TYPE RELATION FROM contact TO permit;
DEFINE INDEX associated_unique ON associated_with FIELDS in, out, role UNIQUE;

-- permit -[parent_of]-> permit  (sub-permits / revisions / phases)
DEFINE TABLE parent_of SCHEMALESS TYPE RELATION FROM permit TO permit;

-- ── Scraper state ────────────────────────────────────────────────────────────

DEFINE TABLE scrape_cursor SCHEMALESS
  COMMENT 'Tracks the last successfully scraped window per module';

DEFINE INDEX scrape_cursor_module ON scrape_cursor FIELDS module UNIQUE;
