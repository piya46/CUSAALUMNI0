// Public organization details only. Never import server environment or credentials here.
export const legalOrganization = {
  name: 'สมาคมนิสิตเก่าวิทยาศาสตร์ จุฬาลงกรณ์มหาวิทยาลัย',
  address: 'คณะวิทยาศาสตร์ ถนนพญาไท แขวงวังใหม่ เขตปทุมวัน กรุงเทพมหานคร 10330',
  phone: '02-252-7634',
  phoneHref: 'tel:+6622527634',
  email: 'support.scicualumni@gmail.com',
};

export const legalVersion = '1.3';
export const legalUpdatedAt = '2026-10-04';
export const legalUpdatedLabel = '4 ตุลาคม 2569';
export type LegalPageKind = 'privacy' | 'terms';

export const legalSources = {
  pdpa: { name: 'พระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562', url: 'https://law.prd.go.th/th/file/get/file/20231122b19b536a4647f29a6d99e228909779b4120136.PDF' },
  transactions: { name: 'พระราชบัญญัติว่าด้วยธุรกรรมทางอิเล็กทรอนิกส์ พ.ศ. 2544 และที่แก้ไขเพิ่มเติม', url: 'https://www.ops.go.th/th/plan-policy/thailand-policy-regulation/item/13621-Electronic-Transactions' },
  computer: { name: 'พระราชบัญญัติว่าด้วยการกระทำความผิดเกี่ยวกับคอมพิวเตอร์ (ฉบับที่ 2) พ.ศ. 2560', url: 'https://ictc.ops.moc.go.th/th/content/category/detail/id/142/iid/5890' },
  traffic: { name: 'หลักเกณฑ์การเก็บรักษาข้อมูลจราจรทางคอมพิวเตอร์ของผู้ให้บริการ พ.ศ. 2564', url: 'https://pub.nstda.or.th/gov-dx/computer-traffic-information/' },
};

export function legalPageForPath(pathname: string): LegalPageKind | null {
  const path = pathname.replace(/\/+$/, '');
  return path === '/privacy' ? 'privacy' : path === '/terms' ? 'terms' : null;
}
