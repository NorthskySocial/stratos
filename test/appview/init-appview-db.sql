-- Create the appview database (in addition to the default 'stratos' db).
-- This file is mounted into postgres initdb.d/ so it runs on first start.
CREATE
DATABASE appview OWNER stratos;
