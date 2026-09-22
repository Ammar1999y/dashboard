import PermissionsPage from '@/components/permissions/page';

export default function Permissions() {
  return <PermissionsPage />;
}

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/permissions',
      title: {
        template: 'الصلاحيات',
      },
    },
  };
}
