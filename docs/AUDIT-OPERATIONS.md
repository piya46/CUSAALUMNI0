# การดูแล Audit log

ระบบใช้ **durable transactional outbox**: request รอให้เขียน `audit_outbox` สำเร็จก่อนตอบกลับ และ mutation ที่ส่ง database connection เดียวกันจะ commit/rollback พร้อม audit event จากนั้น worker ย้าย event ไป `audit_logs` เป็น batch ไม่ใช้ fire-and-forget promises หรือคิวใน memory เป็นหลักฐานถาวร

Worker ใช้ transaction, `SELECT ... FOR UPDATE SKIP LOCKED`, `INSERT audit_logs` และ `DELETE audit_outbox` ภายใน transaction เดียวกัน หาก worker/ฐานข้อมูลหยุดกลาง batch จะ rollback และ event ยังอยู่ใน outbox ถ้า commit แล้ว event จะอยู่ใน log และถูกนำออกจาก outbox พร้อมกัน รองรับ worker หลาย instance บน MariaDB 10.11+ โดยแต่ละ instance ข้ามแถวที่อีก instance ล็อกอยู่

`audit_logs` เป็น append-only สำหรับ runtime มี actor ID/email, session ID, event, status, target, IP, user agent, metadata และเวลา UTC ตารางนี้ไม่มี foreign key ไปยัง user/session จึงเก็บหลักฐานต่อได้หลัง account ถูก soft-delete หรือ session ถูกลบ แต่ไม่ใช่ tamper-proof ต่อ DBA ที่มีสิทธิ์แก้ฐานข้อมูล และไม่มีการอ้างว่าผ่าน certification ด้าน compliance

## สิทธิ์และการปฏิบัติการ

แยกบัญชี migration/DBA ออกจาก runtime อย่างชัดเจน ตัวอย่าง grant เฉพาะ audit tables (แทนชื่อ schema/user/host ให้ตรง environment):

```sql
GRANT SELECT, INSERT, DELETE ON cusa_identity.audit_outbox TO 'cusa_runtime'@'app-host';
GRANT SELECT, INSERT ON cusa_identity.audit_logs TO 'cusa_runtime'@'app-host';
GRANT SELECT ON cusa_identity.audit_logs TO 'cusa_audit_reader'@'archive-host';
GRANT SELECT ON cusa_identity.audit_outbox TO 'cusa_audit_reader'@'archive-host';
```

Runtime ต้องไม่มี `UPDATE`, `DELETE`, `ALTER`, `DROP` หรือสิทธิ์ DDL บน `audit_logs` หลีกเลี่ยง grant ระดับ schema ที่ทำให้ข้อจำกัด table ถูกครอบทับ; ใช้สิทธิ์ที่จำเป็นแยกตาม table อื่นด้วย Worker จำเป็นต้องลบจาก **outbox** หลังย้ายสำเร็จ และไม่ลบจาก audit log

ส่ง credentials ผ่าน secret manager/environment (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_TLS`, `DB_CA_FILE`) ใช้ verified TLS เมื่อเชื่อมผ่าน endpoint สาธารณะ หรือเชื่อมผ่าน loopback/Private IP ภายในที่ผู้ดูแลตรวจสอบแล้วตาม [คู่มือ Plesk](PLESK.md) ใช้บัญชี read-only สำหรับ export เก็บไฟล์ archive ซึ่งมีข้อมูลส่วนบุคคลในพื้นที่เข้ารหัสและจำกัดสิทธิ์ให้ทีมที่ได้รับอนุญาต

## Monitoring และ readiness

`getAuditQueueHealth()` คืน `{pending, oldestAgeSeconds}` และ `getAuditWorkerStatus()` คืน `running`, `faulted`, เวลาประมวลผลล่าสุดและจำนวน batch ที่ล้มเหลวติดกัน เมื่อ batch ล้มเหลวติดกัน 3 ครั้ง worker หยุดตัวเอง (`faulted:true`, `running:false`) และเขียน `CRITICAL` ลง stderr โดยไม่มี payload, SQL หรือข้อความ error จาก driver ค่าปกติรอ 5 วินาทีระหว่างการลองใหม่; batch ที่สำเร็จจะ reset ตัวนับ หากต้องเปลี่ยนพฤติกรรมมี options `retryDelayMs` และ `maxConsecutiveFailures` ที่จุดเริ่ม worker โดย production ใช้ค่า default นี้ ให้ติดตามอย่างน้อย:

- อายุ event ที่เก่าที่สุดเกิน 30 วินาที: แจ้งเตือน; เกิน 60 วินาทีต่อเนื่อง: readiness ของ authentication instance ควรไม่พร้อม ตามค่าที่กำหนดใน deployment
- จำนวน backlog เพิ่มต่อเนื่อง, batch errors, พื้นที่ disk และ transaction/lock latency
- worker ไม่ทำงานเมื่อ instance ถูก configure พร้อมใช้งาน หรือไม่มี batch สำเร็จตามช่วงเวลาที่คาด

ตรวจ thresholds ที่ใช้อยู่จริงใน `/api/ready` และ deployment ก่อนเปิด traffic ไม่ควรใช้ queue length เพียงอย่างเดียว เพราะระบบที่มี traffic สูงอาจมี queue ใหญ่แต่อายุต่ำ ส่วน liveness ควรบอกเพียง process ยังทำงานและไม่บังคับ restart ซ้ำเพราะ dependency ล่ม

Readiness ตอบ 503 เมื่อ worker มี failures หรือหยุดทำงาน ให้ monitoring ภายนอกตรวจ `/api/ready`, อายุ outbox และ `CRITICAL` log แล้ว page ทีม on-call ตามระบบองค์กร แอปไม่ได้ส่ง email/Slack/notification อัตโนมัติ แก้สาเหตุและตรวจหลักฐานก่อนเริ่ม worker/process ใหม่; การ restart ซ้ำโดยไม่แก้ poison event จะกลับมาหยุดอีก

เมื่อ enqueue ไม่สำเร็จ request ต้องไม่รายงาน mutation สำเร็จโดยเงียบ ขณะ shutdown ให้หยุดรับ request, รอ request ที่กำลังทำงาน, เรียก async stop ของ audit worker เพื่อรอ batch ปัจจุบัน และปิด pool เป็นขั้นตอนสุดท้าย outbox ที่ยังไม่ถูก drain จะถูกประมวลผลหลัง restart

Payload ที่ไม่ตรง schema ไม่ถูกทิ้ง Worker rollback ทั้ง batch, เก็บ record เดิม และรายงาน failure โดยไม่พิมพ์ payload/SQL ใน log ให้ DBA ตรวจสาเหตุผ่านช่องทางที่มีสิทธิ์, เก็บหลักฐาน record ต้นฉบับ, แก้ผู้ผลิต payload แล้วทำ audited repair/replay ตามขั้นตอนองค์กร ห้ามแก้ด้วย `INSERT IGNORE` หรือการลบ record ที่เสียโดยไม่มีหลักฐาน เพราะอาจสูญเสีย audit event

## Quarantine poison event โดย DBA

หลังตรวจพบ UUID ที่เสียและสาเหตุแล้ว ให้เก็บ incident/evidence reference, หยุด worker ที่เกี่ยวข้องตามขั้นตอน incident และเก็บสำเนาต้นฉบับในพื้นที่จำกัดสิทธิ์ ตาราง quarantine ด้านล่างเป็น **DBA opt-in แยกจาก migration/runtime** ไม่มีการ grant สิทธิ์ให้ runtime และไม่มีการย้าย/ทิ้ง event อัตโนมัติ การ quarantine ไม่ใช่การแก้ข้อมูลให้สำเร็จ: ต้องติดตาม repair/replay พร้อมหลักฐานต่อจนจบ

สร้างตารางครั้งเดียวก่อน transaction เพราะ DDL อาจ implicit commit:

```sql
CREATE TABLE audit_outbox_quarantine (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  original_payload JSON NOT NULL,
  original_created_at DATETIME(3) NOT NULL,
  payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason TEXT NOT NULL,
  evidence_ref VARCHAR(512) NOT NULL,
  quarantined_by VARCHAR(288) NOT NULL,
  quarantined_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

ตัวอย่างย้าย **ทีละ UUID ที่ตรวจสอบแล้ว** โดยรักษา payload, ID และเวลาเดิมทุกค่า ใช้ hash ที่บันทึกในหลักฐานก่อนหน้าเพื่อป้องกันย้าย record ที่เปลี่ยนไป:

```sql
SET time_zone = '+00:00';
SET @quarantine_event_id = '<exact-investigated-UUID>';
SET @quarantine_expected_sha256 = '<64-character-SHA256-from-evidence>';
SET @quarantine_reason = '<investigated root cause>';
SET @quarantine_evidence_ref = '<incident ID / protected evidence reference>';

START TRANSACTION;
SELECT id, created_at, SHA2(payload, 256) AS payload_sha256
  FROM audit_outbox WHERE id = @quarantine_event_id FOR UPDATE;

INSERT INTO audit_outbox_quarantine
  (id, original_payload, original_created_at, payload_sha256,
   reason, evidence_ref, quarantined_by, quarantined_at)
SELECT id, payload, created_at, SHA2(payload, 256),
       @quarantine_reason, @quarantine_evidence_ref, CURRENT_USER(), UTC_TIMESTAMP(3)
  FROM audit_outbox
 WHERE id = @quarantine_event_id
   AND SHA2(payload, 256) = @quarantine_expected_sha256;
SET @quarantine_copied = ROW_COUNT();

DELETE original FROM audit_outbox AS original
JOIN audit_outbox_quarantine AS evidence ON evidence.id = original.id
 WHERE original.id = @quarantine_event_id AND @quarantine_copied = 1
   AND BINARY evidence.original_payload = BINARY original.payload
   AND evidence.original_created_at = original.created_at
   AND evidence.payload_sha256 = @quarantine_expected_sha256;
SET @quarantine_removed = ROW_COUNT();
SELECT @quarantine_copied AS copied, @quarantine_removed AS removed;
-- DBA verifies both counts are exactly 1 and checks the preserved evidence.
-- Then COMMIT; otherwise ROLLBACK; do not commit after a statement error.
```

อย่าใช้ช่วงกว้างตามอายุ/จำนวน record แทน UUID ที่ตรวจสอบแล้ว และอย่าใช้ `INSERT IGNORE` หาก ID มีอยู่ใน quarantine อยู่แล้ว ให้ rollback และตรวจหลักฐานเดิม ห้ามเขียนทับสำเนาต้นฉบับเพื่อให้ worker ผ่าน เริ่ม worker ใหม่หลังตรวจ queue ที่เหลือและ fix ผู้ผลิตข้อมูลแล้วเท่านั้น

## ประเมินพื้นที่ outbox รายสัปดาห์

การ insert/delete ต่อเนื่องทำให้ InnoDB มี free pages ที่นำกลับมาใช้สำหรับ insert ครั้งต่อไปได้ ขนาดไฟล์ที่ไม่ลดลงตามจำนวนแถวจึงไม่ใช่หลักฐานว่าต้อง rebuild ทุกครั้ง ให้ DBA ตรวจ trend รายสัปดาห์จากจำนวนแถว, `DATA_LENGTH`, `INDEX_LENGTH`, `DATA_FREE`, disk free, latency และ backlog ประกอบกัน; `DATA_FREE` เป็นค่าประมาณและมีความหมายขึ้นกับ tablespace อย่าตัดสินจากค่านี้เพียงค่าเดียว

```sql
SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, DATA_FREE
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = 'cusa_identity' AND TABLE_NAME = 'audit_outbox';

-- DBA maintenance window only, after measured need and staging rehearsal:
-- OPTIMIZE TABLE cusa_identity.audit_outbox;
```

`OPTIMIZE TABLE` อาจ rebuild ตาราง ใช้พื้นที่ชั่วคราวและกระทบ locking/traffic ตาม MariaDB version และการตั้งค่า จึงประเมิน recovery space ที่ต้องการจริง, backup, disk headroom และระยะเวลา maintenance ก่อนทำ ไม่มี unconditional weekly cron และ runtime ไม่ได้รับสิทธิ์ maintenance นี้ ดู [MariaDB OPTIMIZE TABLE](https://mariadb.com/docs/server/ha-and-performance/optimization-and-tuning/optimizing-tables/optimize-table) และ [InnoDB tablespace defragmentation](https://mariadb.com/docs/server/ha-and-performance/optimization-and-tuning/optimizing-tables/defragmenting-innodb-tablespaces)

เวลาใน payload, log และขอบเขต archive ใช้ UTC เหมือนกันทั้งหมด โดย connection pool ตั้ง timezone เป็น `+00:00` และตั้ง SQL session `time_zone = '+00:00'`; DBA session และงาน quarantine ต้องตั้งค่าเดียวกันก่อนใช้ DATETIME ซึ่งไม่มี timezone อยู่ในค่าของคอลัมน์

## Export และตรวจ archive

ตัวอย่าง export ช่วงเดือนสิงหาคม 2026; ช่วงเวลาเป็น UTC แบบรวม `from` และไม่รวม `to`:

```sh
npm run audit:archive -w server -- --from 2026-08-01 --to 2026-09-01 --out /secure-archive/cusa-audit-2026-08.jsonl
npm run audit:archive -w server -- --verify /secure-archive/cusa-audit-2026-08.jsonl
```

หรือใช้ `npx tsx server/src/scripts/auditArchive.ts` กับ arguments เดียวกันจาก root โครงการ Exporter:

1. เปิด read-only consistent snapshot แบบ REPEATABLE READ และปฏิเสธช่วงที่ยังมี event ค้างใน outbox
2. อ่านด้วย keyset `(created_at,id)` ครั้งละ 1,000 records ไม่ใช้ OFFSET จึงไม่ต้องโหลดทั้งเดือนเข้า memory
3. เขียน JSONL เป็น `.partial` ด้วยสิทธิ์ `0600`, sync ไฟล์ และสร้างไฟล์ปลายทางโดยไม่ทับไฟล์เดิม
4. สร้าง `.manifest.json` ที่มีช่วงเวลา, row count เทียบกับ snapshot, เวลา export และ SHA-256 ของ bytes ใน JSONL
5. `--verify` ตรวจ checksum, row count, ช่วงวันที่ และลำดับ keyset จากไฟล์จริง

Script ไม่ลบ audit log และไม่ออก DDL ถ้าล้มเหลวอาจเหลือ `.partial` หรือ JSONL ที่ยังไม่มี manifest ซึ่งต้องถือว่ายัง export ไม่สมบูรณ์ ใช้ชื่อ output ใหม่สำหรับการ retry หลังตรวจสาเหตุ SHA-256 ตรวจความเสียหาย/การเปลี่ยนไฟล์เมื่อมี manifest ที่เชื่อถือได้ แต่ผู้ที่แก้ได้ทั้ง archive และ manifest อาจคำนวณ hash ใหม่ได้ จึงควรเก็บ manifest ใน immutable storage หรือเซ็นด้วย KMS ตามระบบองค์กร

ก่อน retention ต้องยืนยันว่าช่วงเวลาถูกปิดรับ event แล้ว, outbox ระบายหมดในช่วงนั้น, clock ของทุก node ถูกต้อง และไม่มี delayed transaction/backfill ที่จะเติมข้อมูลย้อนหลัง Snapshot เป็นภาพ ณ เวลา export และไม่ได้ล็อกไม่ให้มี event ใหม่เข้าหลัง export ตรวจ row count/ขอบเขตอีกครั้งก่อนตัดข้อมูล, อัปโหลด archive+manifest ไป storage ที่กำหนด, ตรวจ hash หลังอัปโหลด และทดสอบ restore ตัวอย่างข้อมูล

## Partition รายเดือน — DBA opt-in เท่านั้น

Migration ปกติไม่เปิด partition อัตโนมัติ ให้ DBA ประเมินปริมาณข้อมูล, เวลา rebuild/lock, backup, free disk และทดสอบบน staging ก่อน ตารางมี composite primary key `(id, created_at)` อยู่แล้ว เพราะทุก unique key ของ partitioned table ต้องรวม partition key และตาราง partitioned มีข้อจำกัดเรื่อง foreign key

ตัวอย่างแผนเริ่มต้นสำหรับปี 2026 ต้องปรับ boundaries ให้เหมาะกับประวัติข้อมูลจริง:

```sql
-- Run manually in an approved DBA maintenance window, after backup/staging rehearsal.
ALTER TABLE audit_logs
PARTITION BY RANGE COLUMNS(created_at) (
  PARTITION p_before_202608 VALUES LESS THAN ('2026-08-01 00:00:00'),
  PARTITION p202608 VALUES LESS THAN ('2026-09-01 00:00:00'),
  PARTITION p202609 VALUES LESS THAN ('2026-10-01 00:00:00'),
  PARTITION p202610 VALUES LESS THAN ('2026-11-01 00:00:00'),
  PARTITION p_future VALUES LESS THAN (MAXVALUE)
);

-- Add a future month by splitting the catch-all partition before that month begins.
ALTER TABLE audit_logs REORGANIZE PARTITION p_future INTO (
  PARTITION p202611 VALUES LESS THAN ('2026-12-01 00:00:00'),
  PARTITION p_future VALUES LESS THAN (MAXVALUE)
);
```

ใช้ `RANGE COLUMNS(created_at)` ซึ่งแยกปีและเดือนได้ถูกต้อง **ไม่ใช้ `MONTH(created_at)` เพียงอย่างเดียว** เพราะจะรวมเดือนเดียวกันจากหลายปี Archive/retention ยึดช่วง `created_at` UTC จริง ไม่ยึดชื่อ partition เพียงอย่างเดียว

`DROP PARTITION` ลบข้อมูลถาวร จึงต้องเป็น DBA action แยกต่างหากหลัง archive verification, restore check, การตรวจ late arrivals, retention/legal-hold policy และ approval ขององค์กร เอกสารและ exporter นี้ไม่สั่ง drop หรือกำหนด retention days แทนองค์กร ตรวจ partition bounds ด้วย `information_schema.PARTITIONS` ก่อนทุกครั้ง โดยเฉพาะ `p_before_*` ที่อาจรวมประวัติหลายปี

อ้างอิงพฤติกรรม engine จาก [MariaDB SELECT / SKIP LOCKED](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/select), [FOR UPDATE](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/for-update), [Partitioning Limitations](https://mariadb.com/docs/server/server-usage/partitioning-tables/partitioning-limitations) และ [RANGE COLUMNS](https://mariadb.com/docs/server/server-usage/partitioning-tables/partitioning-types/range-columns-and-list-columns-partitioning-types)
