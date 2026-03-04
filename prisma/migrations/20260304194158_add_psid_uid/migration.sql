-- Step 1: Create the reserved_numeric_ids table
CREATE TABLE "reserved_numeric_ids" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "numeric_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reserved_numeric_ids_pkey" PRIMARY KEY ("id")
);

-- Step 2: Add psid/uid columns as nullable first
ALTER TABLE "servers" ADD COLUMN "psid" INTEGER;
ALTER TABLE "users" ADD COLUMN "uid" INTEGER;

-- Step 3: Backfill existing records with random numeric IDs using PL/pgSQL
DO $$
DECLARE
    r RECORD;
    new_psid INTEGER;
    new_uid INTEGER;
    collision BOOLEAN;
BEGIN
    -- Assign PSIDs to existing servers
    FOR r IN SELECT id FROM servers LOOP
        collision := TRUE;
        WHILE collision LOOP
            new_psid := floor(random() * 900000 + 100000)::INTEGER;
            IF NOT EXISTS (SELECT 1 FROM servers WHERE psid = new_psid) THEN
                collision := FALSE;
            END IF;
        END LOOP;

        UPDATE servers SET psid = new_psid WHERE id = r.id;

        INSERT INTO reserved_numeric_ids (id, type, numeric_id, created_at)
        VALUES (
            'rsv_' || substr(md5(random()::text), 1, 21),
            'psid',
            new_psid,
            NOW()
        );
    END LOOP;

    -- Assign UIDs to existing users
    FOR r IN SELECT id FROM users LOOP
        collision := TRUE;
        WHILE collision LOOP
            new_uid := floor(random() * 900000000 + 100000000)::INTEGER;
            IF NOT EXISTS (SELECT 1 FROM users WHERE uid = new_uid) THEN
                collision := FALSE;
            END IF;
        END LOOP;

        UPDATE users SET uid = new_uid WHERE id = r.id;

        INSERT INTO reserved_numeric_ids (id, type, numeric_id, created_at)
        VALUES (
            'rsv_' || substr(md5(random()::text), 1, 21),
            'uid',
            new_uid,
            NOW()
        );
    END LOOP;
END $$;

-- Step 4: Set columns to NOT NULL
ALTER TABLE "servers" ALTER COLUMN "psid" SET NOT NULL;
ALTER TABLE "users" ALTER COLUMN "uid" SET NOT NULL;

-- Step 5: Create unique indexes
CREATE UNIQUE INDEX "servers_psid_key" ON "servers"("psid");
CREATE UNIQUE INDEX "users_uid_key" ON "users"("uid");

-- Step 6: Create indexes for reserved_numeric_ids
CREATE INDEX "reserved_numeric_ids_type_idx" ON "reserved_numeric_ids"("type");
CREATE UNIQUE INDEX "unique_type_numeric_id" ON "reserved_numeric_ids"("type", "numeric_id");
