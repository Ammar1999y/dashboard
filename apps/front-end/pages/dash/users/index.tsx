import UsersPage from '@/components/users/page';

export default function Users() {
  return <UsersPage />;
}

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/users',
      title: {
        template: 'المستخدمين',
      },
    },
  };
}
